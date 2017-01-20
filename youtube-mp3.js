#!/usr/local/bin/node

var ytdl = require('ytdl-core');
var filter = require('filter-object');
var fs = require('fs');
var program = require('commander');
var q = require('q');
var ProgressBar = require('progress');
var ffmpeg = require('fluent-ffmpeg');
var ffMetadata = require('ffmetadata');
var ffProbe = require('node-ffprobe');

var prettyBytes = require('pretty-bytes');
var colors = require('colors/safe');
var sanitize = require('sanitize-filename');

var prompt = require('./prompt.js');
var util = require('./util.js');
var packageJson = require('./package.json');

const TITLE_REGEX = /([\S| ]+)[-|—]([\S| ]+)/;

const META_PROGRESS_BAR_FORMAT = colors.yellow('Downloading metadata\t') + '[:bar] :percent in :elapseds';
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
    .parse(process.argv)

/* Default argument values */
program.lowQuality = !program.lowQuality ? false : true;
program.verbose = !program.verbose ? false : true;

/* TODO: WRITE THE SEPARATOR CODE */
program.separator = program.separator ? program.separator : '-';

/* Validate required arguments */
var url = program.args[0];
if (!url) { 
    program.outputHelp();
    process.exit(55); 
}

printHeader();
debug(colors.yellow('Verbose mode enabled'));

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
    Object.assign({total: 1}, PROGRESS_BAR_OPTIONS)
);

debug('Connecting to youtube...');

ytdl.getInfo(url, function(err, info) {
    if (err) error(err, 'Unable to fetch video metadata from youtube.');
    downloadProgress.tick();
    var targetFormat = program.lowQuality ? 
                        smallestSizeFormat(info) :
                        highestBitrateFormat(info);
    
    if (!targetFormat) error('No formats of this video contain audio.');
    debug('Best match: Itag: ' + targetFormat.itag + '. Audio Quality: ' + targetFormat.audioBitrate + 'kbps.');

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
        error(err, err.message);
    }

    youtube_stream.on('response', function(response) {
        // console.log(response.headers);
        totalSize = parseInt(response.headers['content-length']);
        
        debug('Video file size: ' + prettyBytes(totalSize));
        debug('Starting video content download');
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
    youtube_stream.on('end', function() { debug('Download completed'); downloadCompleted.resolve(); })
    youtube_stream.on('error', function(err) { error(err, 'Unable to download video from youtube.'); });
});


/* Process the video once download is compeleted */
downloadCompleted.promise.then(function() {
    videoFileName = './' + sanitize(videoMetadata.title + '.' + (videoMetadata.format.container || 'mp4'));
    musicFileName = './' + sanitize(videoMetadata.title + '.mp3');

    if (program.output) {
        musicFileName = sanitize(program.output);
        musicFileName = musicFileName.endsWith('.mp3') ? musicFileName : musicFileName + '.mp3';
    }

    /* Output to mp4 file */
    if (!program.intermediate) videoFileName = '/tmp/' + videoFileName;
    debug('Writing video file to ' + videoFileName);
    fs.writeFileSync(videoFileName, data);
    debug('Done writing ' + videoFileName);

    debug('Converting MP3 to ' + musicFileName);
    /* Convert to an mp3 */
    var convertProgress = new ProgressBar(
        CONVERT_PROGRESS_BAR_FORMAT, 
        Object.assign({total: 100}, PROGRESS_BAR_OPTIONS)
    );
    var last = 0;

    ffmpeg(videoFileName)
        .format('mp3')
        .audioBitrate(videoMetadata.format.audioBitrate)
        .on('error', function(err, stdout, stderr) { 
            error(err, 'Ffmpeg encountered an error converting video to mp3.'); 
        })
        .on('progress', function(progress) {
            var diff = Math.ceil(progress.percent) - last;
            last = Math.ceil(progress.percent);
            convertProgress.tick(diff, { rate: progress.currentKbps + 'kbps' });
        })
        .on('end', function() { 
            debug('Finished MP3 conversion');
            if (!program.intermediate) { debug('Deleting temporary file ' + videoFileName); fs.unlinkSync(videoFileName); }
            convertCompleted.resolve();
        })
        .save(musicFileName);
});

/* Write ID3 tags */
convertCompleted.promise.then(function() {
    debug('Writing MP3 metadata');
    endTime = util.nowSeconds();
    var metadata = processMetadata(videoMetadata);
    var filtered = filter(metadata, function(val) { return !!val; });
    ffMetadata.write(musicFileName, metadata, function(err) {
        if (err) warning(err, "Failed to write mp3 metadata.", err);
        metadataCompleted.resolve();
    });
});

/* Report on operation */
metadataCompleted.promise.then(function() {
    debug('Reading ' + musicFileName);
    ffProbe(musicFileName, function(err, data) {
        if (err) error(err, 'Unable to read metadata from ' + musicFileName + ', something went wrong?');
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
function processMetadata(metadata) {
    const meta = {
        title: metadata.title,
        artist: null,
        album: null,
        genre: null,
        date: null
    };

    var songTitleMatch = TITLE_REGEX.exec(metadata.title);
    if (songTitleMatch) {
        debug('Auto-detected song title and artist.');
        meta.artist = songTitleMatch[1].trim();
        meta.title = songTitleMatch[2].trim();
    } else { debug('Unable to auto-detect song title and artist.'); }

    console.log(colors.bold('\nEnter song metadata:'));
    meta.title = prompt(colors.yellow('Title: '), {required: true, default: meta.title});
    meta.artist = prompt(colors.yellow('Artist: '), {required: true, default: meta.artist});
    meta.album = prompt(colors.yellow('Album: '), {required: true, default: 'Single'});
    meta.genre = prompt(colors.yellow('Genre: '));
    meta.date = prompt(colors.yellow('Year: '));

    return meta;
}

function highestBitrateFormat(availableFormats) {
    debug('Finding highest audio bitrate video...');

    var highestBitrate = 0;
    var targetFormat = null;
    
    for (var i in availableFormats.formats) {
        let format = availableFormats.formats[i];
        let bitrate = format.audioBitrate || 0;
        if (bitrate > highestBitrate) {
            highestBitrate = bitrate;
            targetFormat = format;
        }
    }
    return targetFormat;
}

function smallestSizeFormat(availableFormats) {
    debug('Finding smallest video size...');

    var targetFormat = null;
    var smallestSizeBytes = Number.MAX_VALUE;
    
    for (var i in availableFormats.formats) {
        let format = availableFormats.formats[i];

        if (!format.audioBitrate) continue;
        if (!format.clen) continue;

        let fileSize = parseInt(format.clen);

        if (smallestSizeBytes > fileSize) {
            smallestSizeBytes = fileSize;
            targetFormat = format;
        }
    }
    return targetFormat;
}

function error(err, msg) {
    if (!msg) msg = err;
    console.log('\n' + colors.bold(colors.red('ERROR: ')) + colors.red(msg));
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
}
