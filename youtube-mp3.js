#!/usr/local/bin/node

var ytdl = require('ytdl-core');
var fs = require('fs');
var ffmpeg = require('fluent-ffmpeg');
var program = require('commander');
var q = require('q');
var pretty_bytes = require('pretty-bytes');
var ProgressBar = require('progress');

const TITLE_REGEX = /([\S| ]+)-([\S| ]+)/;
const PROGRESS_BAR_WIDTH = 50;
//const PROGRESS_BAR_COMPLETE_CHAR = '\u2588';
const PROGRESS_BAR_COMPLETE_CHAR = '=';
const PROGRESS_BAR_INCOMPLETE_CHAR = ' ';
const META_PROGRESS_BAR_FORMAT = '[:bar] :percent in :elapseds';
const DL_PROGRESS_BAR_FORMAT = '[:bar] :percent @ :rate (:amount) remaining: :etas';

program
    .version('0.1')
    .usage('[options] <youtube_url>')
    .option('-i, --intermediate', 'output intermediate downloaded video file')
    .option('-d, --dry-run', 'download the video but don\'t convert')
    .option('-l, --low-quality', 'download the video at low quality settings')
    .parse(process.argv)

/* Default argument values */
if (!program.dryRun) { program.dryRun = false; }
if (!program.lowQuality) { console.log('LowQuality off'); program.lowQuality = false; }

/* Validate required arguments */
var url = program.args[0];
if (!url) { 
    program.outputHelp();
    process.exit(1); 
}

/* Start downloading the video */
var download_completed = q.defer();

var data = Buffer.alloc(0);
var video_metadata = null;
var total_size = -1;
var total_received = 0;
var start_time = 1;

var download_progress = new ProgressBar('Downloading metadata\t ' + META_PROGRESS_BAR_FORMAT, {
    total: 2, 
    width: PROGRESS_BAR_WIDTH,
    complete: PROGRESS_BAR_COMPLETE_CHAR,
    incomplete: PROGRESS_BAR_INCOMPLETE_CHAR,
    renderThrottle: 50
});

var video_stream = ytdl(url, {
    quality: program.lowQuality ? 'lowest' : 'highest'
})
    .on('info', function(info, format) {
        download_progress.tick();
        video_metadata = info;
    })
    .on('response', function(response) {
        download_progress.tick();
        console.log(response.headers);
        total_size = parseInt(response.headers['content-length']);
        
        download_progress = new ProgressBar('Downloading video\t ' + DL_PROGRESS_BAR_FORMAT, {
            total: total_size,
            width: PROGRESS_BAR_WIDTH,
            complete: PROGRESS_BAR_COMPLETE_CHAR,
            incomplete: PROGRESS_BAR_INCOMPLETE_CHAR,
            renderThrottle: 200
        });
        start_time = Math.floor(Date.now() / 1000);
    })
    .on('error', function(err) {
        console.log('GOT ERROR');
        console.log(err);
    })
    .on('data', function(chunk) {
        total_received += chunk.length;
        data = Buffer.concat([data, chunk], data.length + chunk.length)
        var now = Math.floor(Date.now() / 1000);
        var dl_rate = total_received / Math.max((now - start_time), 1);
        download_progress.tick(chunk.length, {
            'amount': pretty_bytes(total_received) + '/' + pretty_bytes(total_size),
            'rate': pretty_bytes(dl_rate) + '/s'
        });
    })
    .on('end', function() {
        var now = Math.floor(Date.now() / 1000);
        console.log('Download completed in ' + (now - start_time) + 's.\n');
        download_completed.resolve();
    });

/* Process the video once download is compeleted */
download_completed.promise.then(function() {
    console.log('Processing video..');
    console.log('Data: ' + pretty_bytes(data.length));
    var file_name = video_metadata.title;
    var meta = process_metadata(video_metadata);

    /* Output to mp4 file */
    if (program.intermediate) {
        console.log('Outputting video to ' + file_name + '.mp4');
        // var intermediate_file = fs.createWriteStream(file_name + '.mp4');
        // video_stream.pipe(intermediate_file, function() {
        //     console.log('Intermediate file written to ' + file_name + '.mp4');
        // });
        fs.writeFileSync(file_name + '.mp4', data);
    }

    /* Convert to an mp3 */
    if (!program.dryRun) {
        console.log('Outputting audio to ' + file_name + '.mp3');
        console.log('Data: ' + pretty_bytes(data.length));
        var output_music = fs.createWriteStream(file_name + '.mp3');
        ffmpeg(data)
            .inputFormat('mp4')
            .format('mp3')
            .output(output_music)
            .outputOptions(meta)
            .on('end', function() { console.log('Done converting'); })
            .run();
    }
});

/* Helper to parse the youtube metadata */
function process_metadata(metadata) {
    console.log('Processing metdata...');
    const result = {
        title: metadata.title
    };

    var song_title_match = TITLE_REGEX.exec(metadata.title);
    if (song_title_match) {
        result.artist = song_title_match[1].trim();
        result.album_artist = song_title_match[1].trim();
        result.title = song_title_match[2].trim();
    }
    else {
        console.log('Video title did not match format <artist> - <song title>.');
    }

    const result_arr = [];
    Object.keys(result).forEach(function(key) {
        result_arr.push('metadata');
        result_arr.push(key + '=' + result['key']);
    });
    return result_arr;
}

