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

var prompt = require('./prompt.js');
var util = require('./util.js');

const TITLE_REGEX = /([\S| ]+)-([\S| ]+)/;

//const PROGRESS_BAR_COMPLETE_CHAR = '\u2588';
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
    .version('0.1')
    .usage('[options] <youtube_url>')
    .option('-i, --intermediate', 'output intermediate downloaded video file')
    .option('-l, --low-quality', 'download the video at low quality settings')
    .parse(process.argv)

/* Default argument values */
program.lowQuality = !program.lowQuality ? false : true;

/* Validate required arguments */
var url = program.args[0];
if (!url) { 
    program.outputHelp();
    process.exit(1); 
}

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

/* Start downloading the video */
ytdl(url, {
    quality: program.lowQuality ? 'lowest' : 'highest',
    filter: function(format) { return format.container === 'mp4'; }
})
    .on('info', function(info, format) {
        downloadProgress.tick();
        videoMetadata = info;
    })
    .on('response', function(response) {
        downloadProgress.tick();
        // console.log(response.headers);
        totalSize = parseInt(response.headers['content-length']);
        
        downloadProgress = new ProgressBar(
            DL_PROGRESS_BAR_FORMAT, 
            Object.assign({total: totalSize}, PROGRESS_BAR_OPTIONS)
        );
    })
    .on('error', function(err) {
        console.log('GOT ERROR');
        console.log(err);
    })
    .on('data', function(chunk) {
        data = Buffer.concat([data, chunk], data.length + chunk.length)
        var now = util.nowSeconds();
        var dl_rate = data.length / Math.max((now - startTime), 1);
        downloadProgress.tick(chunk.length, {
            'amount': prettyBytes(data.length) + '/' + prettyBytes(totalSize),
            'rate': prettyBytes(dl_rate) + '/s'
        });
    })
    .on('end', function() {
        downloadCompleted.resolve();
    });

/* Process the video once download is compeleted */
downloadCompleted.promise.then(function() {
    videoFileName = videoMetadata.title + '.mp4';
    musicFileName = videoMetadata.title + '.mp3';

    /* Output to mp4 file */
    if (!program.intermediate) videoFileName = '/tmp/' + videoFileName;
    fs.writeFileSync(videoFileName, data);

    /* Convert to an mp3 */
    var output_music = fs.createWriteStream(musicFileName);
    var convert_progress = new ProgressBar(
        CONVERT_PROGRESS_BAR_FORMAT, 
        Object.assign({total: 100}, PROGRESS_BAR_OPTIONS)
    );
    var last = 0;

    ffmpeg(videoFileName)
        .format('mp3')
        .output(output_music)
        .on('error', function(err, stdout, stderr) { 
            console.log('Unable to convert to mp3'); 
            console.log(err);
            console.log(stdout);
            console.log(stderr);
        })
        .on('progress', function(progress) {
            var diff = Math.ceil(progress.percent) - last;
            last = Math.ceil(progress.percent);
            convert_progress.tick(diff, { rate: progress.currentKbps + 'kbps' });
        })
        .on('end', function() { 
            if (!program.intermediate) { fs.unlinkSync(videoFileName); }
            convertCompleted.resolve();
        })
        .run();
});

/* Write ID3 tags */
convertCompleted.promise.then(function() {
    endTime = util.nowSeconds();
    var metadata = processMetadata(videoMetadata);
    var filtered = filter(metadata, function(val) { return !!val; });
    ffMetadata.write(musicFileName, metadata, function(err) {
        if (err) console.error("Error writing metadata", err);
        metadataCompleted.resolve();
    });
});

/* Report on operation */
metadataCompleted.promise.then(function() {
    console.log('\n' + colors.green('Conversion Completed!'));
    ffProbe(musicFileName, function(err, data) {
        if (err) console.log('Unable to read mp3 file');
        else {
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
    var song_title = metadata.title;
    var song_artist = null;
    const meta = {
        title: null,
        artist: null,
        album: null,
        genre: null,
        date: null
    };

    var song_title_match = TITLE_REGEX.exec(metadata.title);
    if (song_title_match) {
        meta.artist = song_title_match[1].trim();
        meta.title = song_title_match[2].trim();
    }

    console.log('\nEnter song metadata:');
    meta.title = prompt(colors.yellow('Title: '), {required: true, default: meta.title});
    meta.artist = prompt(colors.yellow('Artist: '), {required: true, default: meta.artist});
    meta.album = prompt(colors.yellow('Album: '), {required: true});
    meta.genre = prompt(colors.yellow('Genre: '));
    meta.date = prompt(colors.yellow('Year: '));

    return meta;
}
