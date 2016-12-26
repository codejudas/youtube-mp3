#!/usr/local/bin/node

var ytdl = require('ytdl-core');
var fs = require('fs');
var ffmpeg = require('fluent-ffmpeg');
var program = require('commander');
var q = require('q');
var pretty_bytes = require('pretty-bytes');
var ProgressBar = require('progress');
var FFMetadata = require('ffmetadata');


const TITLE_REGEX = /([\S| ]+)-([\S| ]+)/;
const DISCOG_TOKEN = 'FqMPINiCFFlFYrtXVJszMbmuZKlgqktmZvCsTgRq';

//const PROGRESS_BAR_COMPLETE_CHAR = '\u2588';
const META_PROGRESS_BAR_FORMAT = '[:bar] :percent in :elapseds';
const DL_PROGRESS_BAR_FORMAT = '[:bar] :percent @ :rate (:amount) remaining: :etas';
const CONVERT_PROGRESS_BAR_FORMAT = '[:bar] :percent @ :rate in :elapseds remaining: :etas';
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
    .option('-d, --dry-run', 'download the video but don\'t convert')
    .option('-l, --low-quality', 'download the video at low quality settings')
    .parse(process.argv)

/* Default argument values */
if (!program.dryRun) { program.dryRun = false; }
if (!program.lowQuality) { program.lowQuality = false; }

/* Validate required arguments */
var url = program.args[0];
if (!url) { 
    program.outputHelp();
    process.exit(1); 
}

var download_completed = q.defer();
var convert_completed = q.defer();

var data = Buffer.alloc(0);
var video_metadata = null;
var video_file_name = null;
var music_file_name = null;
var total_size = -1;

var start_time = 1;

var download_progress = new ProgressBar(
    'Downloading metadata\t ' + META_PROGRESS_BAR_FORMAT, 
    Object.assign({total: 2}, PROGRESS_BAR_OPTIONS)
);

/* Start downloading the video */
var video_stream = ytdl(url, {
    quality: program.lowQuality ? 'lowest' : 'highest',
    filter: function(format) { return format.container === 'mp4'; }
})
    .on('info', function(info, format) {
        download_progress.tick();
        video_metadata = info;
    })
    .on('response', function(response) {
        download_progress.tick();
        // console.log(response.headers);
        total_size = parseInt(response.headers['content-length']);
        
        download_progress = new ProgressBar(
            'Downloading video\t ' + DL_PROGRESS_BAR_FORMAT, 
            Object.assign({total: total_size}, PROGRESS_BAR_OPTIONS)
        );

        start_time = Math.floor(Date.now() / 1000);
    })
    .on('error', function(err) {
        console.log('GOT ERROR');
        console.log(err);
    })
    .on('data', function(chunk) {
        data = Buffer.concat([data, chunk], data.length + chunk.length)
        var now = Math.floor(Date.now() / 1000);
        var dl_rate = data.length / Math.max((now - start_time), 1);
        download_progress.tick(chunk.length, {
            'amount': pretty_bytes(data.length) + '/' + pretty_bytes(total_size),
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

    video_file_name = video_metadata.title + '.mp4';
    music_file_name = video_metadata.title + '.mp3';

    /* Output to mp4 file */
    if (program.intermediate) {
        console.log('Outputting video to ' + video_file_name);
    } else {
        video_file_name = '/tmp/' + video_file_name;
    }
    fs.writeFileSync(video_file_name, data);

    /* Convert to an mp3 */
    if (!program.dryRun) {
        console.log('Outputting audio to ' + music_file_name);
        var output_music = fs.createWriteStream(music_file_name);
        var convert_progress = new ProgressBar(
            'Converting to mp3\t ' + CONVERT_PROGRESS_BAR_FORMAT, 
            Object.assign({total: 100}, PROGRESS_BAR_OPTIONS)
        );
        var last = 0;

        ffmpeg(video_file_name)
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
                console.log('Done converting');
                if (!program.intermediate) { fs.unlinkSync(video_file_name); }
                convert_completed.resolve();
            })
            .run();
    }
});

/* Write ID3 tags */
if (!program.dryRun) {
    convert_completed.promise.then(function() {
        console.log('Writing ID3 tags...');
        metadata = process_metadata(video_metadata);
        FFMetadata.write(music_file_name, metadata, function(err) {
            if (err) console.error("Error writing metadata", err);
            else console.log("ID3 tags written");
        });
    });
}

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
        console.log('Video title did not match format "<artist> - <song title>".');
    }

    console.log('metadata: ' + JSON.stringify(result));
    return result;
}

