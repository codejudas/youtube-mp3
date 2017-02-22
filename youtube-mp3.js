#!/usr/local/bin/node
const fluent_ffmpeg = './node_modules/fluent-ffmpeg';

const ytdl = require('ytdl-core');
const fs = require('fs');
const program = require('commander');
const q = require('q');
const ProgressBar = require('progress');
const ffmpeg = require(fluent_ffmpeg);
const ffMetadata = require('ffmetadata');
const ffProbe = require('node-ffprobe');
const path = require('path');
const fsExtra = require('fs-extra');
const request = require('sync-request');

const prettyBytes = require('pretty-bytes');
const colors = require('colors/safe');
const sanitize = require('sanitize-filename');
const escapeStringRegexp = require('escape-string-regexp');

const prompt = require('./prompt.js');
const util = require('./util.js');
const packageJson = require('./package.json');

const DEFAULT_SEPARATORS = ['-', '—']
const ITUNES_API_BASE = 'https://itunes.apple.com/search?term=';
const METADATA_FIELDS = ['title', 'artist', 'album', 'genre', 'date'];

const META_PROGRESS_BAR_FORMAT = colors.yellow('Downloading metadata\t') + '[:bar] :percent in :elapseds :msg';
const DL_PROGRESS_BAR_FORMAT = colors.yellow('Downloading video\t') + '[:bar] :percent @ :rate (:amount) remaining: :etas';
const CONVERT_PROGRESS_BAR_FORMAT = colors.yellow('Converting to mp3\t') + '[:bar] :percent @ :rate in :elapseds remaining: :etas';
const PROGRESS_BAR_OPTIONS = {
    width: 50,
    complete: '=',
    incomplete: ' ',
    renderThrottle: 200
};

program
    .version(packageJson.version)
    .usage('[options] <youtube_url>')
    .description('A simple command line tool to download a youtube video and convert it to an mp3 (v' + packageJson.version +')')
    .option('-o, --output <output_file>', 'output the final mp3 to this file name')
    .option('-i, --intermediate', 'output intermediate downloaded video file')
    .option('-l, --low-quality', 'download the video at low quality settings')
    .option('-v, --verbose', 'print additional information during run, useful for debugging')
    .option('-s, --separator <separator>', 'set the seperator for artist/song in video title')
    .option('-b, --bitrate <rate>', 'set the output mp3 bitrate in kbps')
    .parse(process.argv)

/* Default argument values */
program.lowQuality = !program.lowQuality ? false : true;
program.verbose = !program.verbose ? false : true;

program.separator = program.separator ? [program.separator] : DEFAULT_SEPARATORS;

/* Validate required arguments */
var url = program.args[0];
if (!url) { 
    program.outputHelp();
    process.exit(55); 
}

if (program.bitrate && (program.bitrate < 32 || program.bitrate > 320)) error('Bitrate must be between 10 and 320 kbps');

printHeader();
debug(colors.yellow('Verbose mode enabled'));
debug('Using ' + program.separator.map(function (e) { return '\'' + e + '\''; }).join(', ') + ' as video title separator(s).');
if (program.bitrate) debug('Set output mp3 bitrate to ' + program.bitrate + 'kbps.');
debug('');

var infoCompleted = q.defer();
var downloadCompleted = q.defer();
var convertCompleted = q.defer();
var metadataCompleted = q.defer();

var data = Buffer.alloc(0);
var videoMetadata = null;
var videoFileName = null;
var musicFileName = null;
var totalSize = -1;

var startTime = util.nowSeconds();
var endTime = util.nowSeconds();

var downloadProgress = new ProgressBar(
    META_PROGRESS_BAR_FORMAT, 
    Object.assign({total: 2}, PROGRESS_BAR_OPTIONS)
);

debug('Connecting to youtube...');

ytdl.getInfo(url, function(err, info) {
    if (err) error(err, 'Unable to fetch video metadata from youtube.');
    downloadProgress.tick({'msg': ''});
    var targetFormat = program.lowQuality ? 
                        util.smallestSizeFormat(info) :
                        util.highestBitrateFormat(info);
    
    if (!targetFormat) error('No formats of this video contain audio.');
    downloadProgress.tick(1, {'msg': colors.yellow('bitrate: ' + targetFormat.audioBitrate + 'kbps')});
    debug('Best match: Itag: ' + targetFormat.itag + '.');

    videoMetadata = {
        title: info.title,
        format: targetFormat
    };
    infoCompleted.resolve(videoMetadata);
});

infoCompleted.promise.then(function(metadata) {
    /* Start downloading the video */
    var youtube_stream = null;
    try {
        youtube_stream = ytdl(url, {quality: metadata.format.itag});
    } catch (err) {
        error(err, 'Unable to download video from youtube.');
    }

    youtube_stream.on('response', function(response) {
        totalSize = parseInt(response.headers['content-length']);
        
        debug('Video file size: ' + prettyBytes(totalSize) + '\n');
        downloadProgress = new ProgressBar(
            DL_PROGRESS_BAR_FORMAT, 
            Object.assign({total: totalSize}, PROGRESS_BAR_OPTIONS)
        );
    });
    youtube_stream.on('data', function(chunk) {
        data = Buffer.concat([data, chunk], data.length + chunk.length)
        var now = util.nowSeconds();
        var dlRate = data.length / Math.max((now - startTime), 1);
        downloadProgress.tick(chunk.length, {
            'amount': prettyBytes(data.length) + '/' + prettyBytes(totalSize),
            'rate': prettyBytes(dlRate) + '/s'
        });
    });
    youtube_stream.on('end', function() { downloadCompleted.resolve(); })
    youtube_stream.on('error', function(err) { error(err, 'Unexpected problem while downloading video.'); });
});


/* Process the video once download is compeleted */
downloadCompleted.promise.then(function() {
    videoFileName = '/tmp/' + sanitize(videoMetadata.title + '.' + (videoMetadata.format.container || 'mp4'));
    musicFileName = '/tmp/' + sanitize(videoMetadata.title + '.mp3');

    /* Output to mp4 file */
    if (program.intermediate) videoFileName = path.join('./', path.basename(videoFileName));

    debug('Writing video file to ' + videoFileName + '...');
    fs.writeFileSync(videoFileName, data);

    debug('');
    debug('Converting MP3 to ' + musicFileName);
    /* Convert to an mp3 */
    var convertProgress = new ProgressBar(
        CONVERT_PROGRESS_BAR_FORMAT, 
        Object.assign({total: 100}, PROGRESS_BAR_OPTIONS)
    );
    var last = 0;

    let outputBitrate = program.bitrate || videoMetadata.format.audioBitrate;

    ffmpeg(videoFileName)
        .format('mp3')
        .audioBitrate(outputBitrate)
        .on('error', function(err, stdout, stderr) { 
            error(err, 'Ffmpeg encountered an error converting video to mp3.'); 
        })
        .on('progress', function(progress) {
            var diff = Math.ceil(progress.percent) - last;
            last = Math.ceil(progress.percent);
            convertProgress.tick(diff, { rate: progress.currentKbps + 'kbps' });
        })
        .on('end', function() { 
            if (!program.intermediate) { debug('Deleting temporary file ' + videoFileName); fs.unlinkSync(videoFileName); }
            convertCompleted.resolve();
        })
        .save(musicFileName);
});

/* Write ID3 tags */
convertCompleted.promise.then(function() {
    debug('');
    debug(colors.yellow('Processing video metadata...'));
    endTime = util.nowSeconds();

    var metadata = gatherMetadata(videoMetadata);
    metadata = util.filter(metadata, function(k, v) { 
        if (!v) return false;
        return METADATA_FIELDS.includes(k);
    });

    debug('');
    debug('Writing mp3 metadata...');
    ffMetadata.write(musicFileName, metadata, function(err) {
        if (err) warning(err, "Failed to write mp3 metadata.", err);
        metadataCompleted.resolve(metadata);
    });
});

/* Report on operation */
metadataCompleted.promise.then(function(metadata) {
    var outputFileName = './' + metadata.artist + ' - ' + metadata.title + '.mp3';

    if (program.output) {
        outputFileName = sanitize(program.output);
        outputFileName = outputFileName.endsWith('.mp3') ? outputFileName : outputFileName + '.mp3';
    }

    debug('Writing final mp3 file: ' + outputFileName);
    try {
        fsExtra.copySync(musicFileName, outputFileName);
        fs.unlink(musicFileName);
    } catch (err) {
        error(err, 'Unable to write ' + outputFileName + '.');
    }

    debug('Reading ' + outputFileName);
    ffProbe(outputFileName, function(err, data) {
        if (err) error(err, 'Unable to read metadata from ' + outputFileName + '.');
        else {
            console.log('\n' + colors.bold(colors.green('Conversion Completed!')));
            console.log(colors.green('Runtime:\t' + util.prettyTime(endTime - startTime)));
            console.log(colors.green('File:\t\t' + data.filename));
            console.log(colors.green('Size:\t\t' + prettyBytes(data.format.size)));
            console.log(colors.green('Length:\t\t' + util.prettyTime(data.format.duration)));
            console.log(colors.green('Bit Rate:\t' + prettyBytes(data.format.bit_rate) + 'ps'));
        }
    });
});

/* Helper to parse the youtube metadata */
function gatherMetadata(metadata) {
    const meta = {
        title: metadata.title,
        artist: null,
        album: null,
        genre: null,
        date: null
    };

    /* First try reading from itunes api */
    var result = loadItunesMeta(metadata.title);
    if (result.success) {
        Object.assign(meta, result);
    } else {
        /* Fallback to parsing video title if no results from itunes */
        debug('Falling back to parsing video title...');
        result = parseVideoTitle(metadata.title);
        if (result.success) {
            meta.title = result.title;
            meta.artist = result.artist;
            /* Try searching itunes with cleaner search term */
            result = loadItunesMeta(meta.artist + ' ' + meta.title);
            if (result.success) {
                Object.assign(meta, result);
            }
        }
    }

    /* Use discovered values as defaults for user to confirm */
    console.log(colors.bold('\nEnter song metadata:'));
    meta.title = prompt(colors.yellow('Title: '), {required: true, default: meta.title});
    meta.artist = prompt(colors.yellow('Artist: '), {required: true, default: meta.artist});
    meta.album = prompt(colors.yellow('Album: '), {required: true, default: meta.album || 'Single'});
    meta.genre = prompt(colors.yellow('Genre: '), {default: meta.genre});
    meta.date = prompt(colors.yellow('Year: '), {default: meta.date});

    return meta;
}

/* Helper that uses the Itunes API to auto-detect song metadata */
function loadItunesMeta(searchTerm) {
    let url = ITUNES_API_BASE + encodeURIComponent(searchTerm);
    debug('Searching Itunes for \'' + searchTerm + '\' (' + url + ')');
    let response = request('GET', url);
    
    if (response.statusCode !== 200) {
        debug('Itunes API returned ' + response.statusCode + ' status code.');
        return { success: false };
    }

    let results = JSON.parse(response.getBody('utf8')).results || [];

    results.filter(e => { 
        if (e.kind !== 'song') return false;
        if (searchTerm.search(new RegExp(e.trackName, 'i')) < 0) return false;
        if (searchTerm.search(new RegExp(e.artistName, 'i')) < 0) return false;
        return true;
    });

    let match = results.shift();
    if (!match) {
        debug('No matches found on Itunes.');
        return { success: false };
    }

    debug('Found a match on Itunes.');
    return {
        success: true,
        title: match.trackName,
        artist: match.artistName,
        album: match.collectionName,
        albumUrl: match.artworkUrl100,
        trackNum: match.trackNumber,
        trackCount: match.trackCount,
        genre: match.primaryGenreName,
        date: match.releaseDate.slice(0,4)
    };
}

/* Parses the video title to extract song title and artist, trim unnecessary info */
function parseVideoTitle(videoTitle) {
    let meta = {success: false};

    var separators = program.separator.map(function(e) { return escapeStringRegexp(e); });
    separators = separators.join('|');
    var titleRegex = new RegExp('([\\S ]+) (' + separators + ') ([\\S ]+)');

    var songTitleMatch = titleRegex.exec(videoTitle);
    if (songTitleMatch) {
        debug('Auto-detected song title and artist.');
        meta.artist = songTitleMatch[1].trim();
        meta.title = songTitleMatch[3].trim();

        meta.title = util.trimString(meta.title, '"');
        meta.title = util.trimString(meta.title, '\'');

        meta.title = util.removeTrailing(meta.title, '(official video)');
        meta.title = util.removeTrailing(meta.title, 'official video');
        meta.title = util.removeTrailing(meta.title, 'high quality');
        meta.title = util.removeTrailing(meta.title, 'lyrics');

        meta.success = true;
    } else { debug('Unable to auto-detect song title and artist from video title.'); }
    return meta;
}

function error(err, msg) {
    if (!msg) msg = err;
    console.log('\n' + colors.bold(colors.red('ERROR: ')) + colors.red(msg));
    console.log(colors.red(err));
    process.exit(25);
}

function warning(err, msg) {
    console.log('\n' + colors.bold(colors.yellow('WARNING: ')) + colors.yellow(msg));
}

function debug(msg) {
    if (program.verbose) {
        console.log(msg);
    }
}

function printHeader() {
	console.log(colors.bold(colors.america("\n__  __             __          __             __              __  ___   ___    ____")));
	console.log(colors.bold(colors.america("\\ \\/ / ___  __ __ / /_ __ __  / /  ___       / /_ ___        /  |/  /  / _ \\  |_  /")));
	console.log(colors.bold(colors.america(" \\  / / _ \\/ // // __// // / / _ \\/ -_)     / __// _ \\      / /|_/ /  / ___/ _/_ < ")));
	console.log(colors.bold(colors.america(" /_/  \\___/\\_,_/ \\__/ \\_,_/ /_.__/\\__/      \\__/ \\___/     /_/  /_/  /_/    /____/ \n")));
	console.log(colors.bold(colors.america("                                      (" + packageJson.version + ")\n")));
}
