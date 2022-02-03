#!/usr/local/bin/node
import ytdl from 'ytdl-core';
import * as fs from 'fs';
import { Command } from 'commander/esm.mjs';
import ProgressBar from 'progress';
import ffmpeg from 'fluent-ffmpeg';
import ffMetadata from 'ffmetadata';
import ffProbe from 'node-ffprobe';
import * as path from 'path';
import fsExtra from 'fs-extra';
import request from 'sync-request';
import prompt from 'prompt';

import prettyBytes from 'pretty-bytes';
import chalk from 'chalk';
import sanitize from 'sanitize-filename';

import * as util from './util.js';
import { Log } from './logging.js';

const DEFAULT_SEPARATORS = ['-', '—']
const ITUNES_API_BASE = 'https://itunes.apple.com/search?term=';
const METADATA_FIELDS = ['title', 'artist', 'album', 'genre', 'date'];

const META_PROGRESS_BAR_FORMAT = chalk.yellow('Downloading metadata\t') + '[:bar] :percent in :elapseds :msg';
const DL_PROGRESS_BAR_FORMAT = chalk.yellow('Downloading video\t') + '[:bar] :percent @ :dlSpeed (:amount) remaining: :etas';
const CONVERT_PROGRESS_BAR_FORMAT = chalk.yellow('Converting to mp3\t') + '[:bar] :percent @ :speed in :elapseds remaining: :etas';
const PROGRESS_BAR_OPTIONS = {
    width: 50,
    complete: '=',
    incomplete: ' ',
    renderThrottle: 200
};


const program = new Command();
program
    .version(getVersion())
    .usage('[options] <youtube_url>')
    .description('A simple command line tool to download a youtube video and convert it to an mp3 (v' + getVersion() +')')
    .option('-o, --output <output_file>', 'output the final mp3 to this file name')
    .option('--video', 'download the video file and exit')
    .option('-l, --low-quality', 'download the video at low quality settings', false)
    .option('-v, --verbose', 'print additional information during run, useful for debugging', false)
    .option('-s, --separator <separator...>', 'set the seperator for artist/song in video title', DEFAULT_SEPARATORS)
    .option('-b, --bitrate <rate>', 'set the output mp3 bitrate in kbps (default is highest available bitrate)')
    .parse(process.argv)

const options = program.opts();
const log = new Log(options.verbose);

main(program.args[0], options);

/**
 * Execute the program on the provided args
 * @param {String} youtubeUrl Url of the youtube Video to download
 * @param {*} options Options passed on the command line
 */
async function main(youtubeUrl, options) {
  /* Validate required arguments */
  if (!youtubeUrl) {
    program.outputHelp();
    process.exit(55);
  }

  if (options.bitrate && (options.bitrate < 32 || options.bitrate > 320)) log.error('Bitrate must be between 32 and 320 kbps');

  /* Execute program */
  printHeader();
  log.debug('Verbose mode enabled');
  log.debug('Using ' + options.separator.map((e) => '\'' + e + '\'').join(', ') + ' as video title separator(s).');
  if (options.bitrate) log.debug('Set output mp3 bitrate to ' + options.bitrate + 'kbps.');

  const startTime = util.nowSeconds();

  const info = await downloadMetadata(youtubeUrl, options.lowQuality);
  const video = await downloadVideo(youtubeUrl, info);
  const videoFile = writeVideoFile(info, video, options.video);
  if (!options.video) {
    const mp3File = await convertVideoToMp3(info, videoFile, !options.video, options.bitrate);

    /* Save the endTime here because this is the real time it took to download and convert to an MP3 */
    const endTime = util.nowSeconds();

    const id3Tags = await writeId3Tags(mp3File, info, options.separator);
    const finalMetadata = await finalizeMp3(id3Tags, mp3File, options.output);

    log.info('\n' + chalk.bold(chalk.green('Conversion Completed!')));
    log.info(chalk.green('Runtime:\t' + util.prettyTime(endTime - startTime)));
    log.info(chalk.green('File:\t\t' + finalMetadata.filename));
    log.info(chalk.green('Size:\t\t' + prettyBytes(finalMetadata.format.size)));
    log.info(chalk.green('Length:\t\t' + util.prettyTime(finalMetadata.format.duration)));
    log.info(chalk.green('Bit Rate:\t' + prettyBytes(finalMetadata.format.bit_rate) + 'ps'));
  }
}

/**
 * Load metadata from youtube for the given url and select the best fitting quality setting
 * @param {String} url URL to the youtube video to gather metadata for
 * @param {Boolean} isLowQualityPreferred Whether user prefers lowest quality audio, default is false
 * @returns Video metadata used to download the video
 */
async function downloadMetadata(url, isLowQualityPreferred) {
  log.debug('Connecting to youtube...');

  const downloadProgress = new ProgressBar(
    META_PROGRESS_BAR_FORMAT,
    Object.assign({ total: 2, 'msg': chalk.yellow('connecting') }, PROGRESS_BAR_OPTIONS)
  );

  let info;
  try {
    info = await ytdl.getInfo(url);
    downloadProgress.tick(1, { 'msg': chalk.green('downloaded') });
    var targetFormat = isLowQualityPreferred ?
      util.smallestSizeFormat(info) :
      util.highestBitrateFormat(info);

    if (!targetFormat) error('No formats of this video contain audio.');
    downloadProgress.tick(1, { 'msg': chalk.yellow('bitrate: ' + targetFormat.audioBitrate + 'kbps') });
    log.debug('Best match: Itag: ' + targetFormat.itag + '.');

    var title = 'unknown';
    try {
      title = util.parseSongName(info.videoDetails);
    } catch (e) {
      log.debug('Unable to determine song name due to: ' + e.stack);
    }

    const videoMetadata = {
      title: title,
      format: targetFormat
    };
    log.debug('Video metadata: ' + JSON.stringify(videoMetadata));
    return videoMetadata;
  } catch (err) {
    log.error(err, 'Unable to fetch video metadata from youtube.');
    throw err;
  }
}

/**
 * Download the youtube video at the specified url and with the given metadata settings (containing the specific ITAG to download)
 * @param {String} url URL of the youtube video to download
 * @param {*} metadata 
 * @returns A Promise which will contain the raw video bytes.
 */
function downloadVideo(url, metadata) {
  /* Start downloading the video */
  let downloadProgress;
  let data = Buffer.alloc(0);
  let dlStartTime = util.nowSeconds();

  try {
    return new Promise((resolve) => {
      ytdl(url, { quality: metadata.format.itag }) //TODO: Maybe just use 'highestaudio'
        .on('progress', (chunkLen, totalDownloaded, totalSize) => {
          if (!downloadProgress) {
            downloadProgress = new ProgressBar(
              DL_PROGRESS_BAR_FORMAT,
              Object.assign({ total: totalSize }, PROGRESS_BAR_OPTIONS)
            );
          }

          var now = util.nowSeconds();
          var ratio = totalDownloaded / totalSize;
          var dlRate = totalDownloaded / Math.max((now - dlStartTime), 1);
          downloadProgress.update(ratio, {
            'amount': prettyBytes(totalDownloaded) + '/' + prettyBytes(totalSize),
            'dlSpeed': prettyBytes(dlRate) + '/s'
          });
        })
        .on('data', (chunk) => {
          data = Buffer.concat([data, chunk], data.length + chunk.length);
        })
        .on('end', () => { resolve(data); })
        .on('error', (err) => log.error(err, 'Unexpected problem while downloading video.'));
    });
  } catch (err) {
    log.error(err, 'Unable to download video from youtube.');
    process.exit(54); 
  }
}

/**
 * Write the video file to local disk
 * @param {*} videoMetadata  Video metadata retrieved from youtube
 * @param {Buffer} data the raw bytes of the video file
 * @param {Boolean} videoOnlyMode Whether youtube-mp3 is running in video only mode or not
 * @returns path to written video
 */
function writeVideoFile(videoMetadata, data, videoOnlyMode) {
  let videoFileName = sanitize(videoMetadata.title + '.' + (videoMetadata.format.container || 'mp4'));
  if (videoOnlyMode) {
    videoFileName = path.join('./', path.basename(videoFileName));
    log.info('Writing video file to ' + videoFileName);
  } else {
    videoFileName = path.join('/tmp/', path.basename(videoFileName));
    log.debug('Writing intermediate video file to ' + videoFileName);
  }
  fs.writeFileSync(videoFileName, data);
  return videoFileName;
}

/**
 * Convert the video data into an MP3 using ffmpeg
 * @param {*} videoMetadata Video metadata retrieved from youtube
 * @param {Buffer} data The raw bytes of the video file
 * @param {Boolean} keepVideoFile Whether to keep the intermediate downloaded video file
 * @param {Number} bitrate Desired bitrate of the outputted mp3, defaults to the source video file audio bitrate
 * @returns A Promise containing the file name of the converted mp3
 */
function convertVideoToMp3(videoMetadata, videoFileName, keepVideoFile, bitrate) {
  const musicFileName = '/tmp/' + sanitize(videoMetadata.title + '.mp3');
  const outputBitrate = bitrate || videoMetadata.format.audioBitrate;

  log.debug('Converting MP3 to ' + musicFileName);
  /* Convert to an mp3 */
  var convertProgress = new ProgressBar(
    CONVERT_PROGRESS_BAR_FORMAT,
    Object.assign({ total: 100 }, PROGRESS_BAR_OPTIONS)
  );
  var last = 0;

  return new Promise((resolve) => {
    ffmpeg(videoFileName)
      .format('mp3')
      .audioBitrate(outputBitrate)
      .on('error', function (err, stdout, stderr) {
        log.error(err, 'Ffmpeg encountered an error converting video to mp3.');
        process.exit(53);
      })
      .on('progress', function (progress) {
        var diff = Math.ceil(progress.percent) - last;
        last = Math.ceil(progress.percent);
        convertProgress.tick(diff, { speed: progress.currentKbps + 'kbps' });
      })
      .on('end', function () {
        if (!keepVideoFile) { log.debug('Deleting intermediate video file ' + videoFileName); fs.unlinkSync(videoFileName); }
        resolve(musicFileName);
      })
      .save(musicFileName);
  });
}

/**
 * Gather song metadata and write ID3 tags to the MP3 file
 * @param {String} musicFileName Name of the MP3 file
 * @param {*} videoMetadata Video metadata downloaded from youtube
 * @param {Array} separators Separators to use when attempting to manually parse the video title
 * @returns A Promise containing the final resolved metadata
 */
async function writeId3Tags(musicFileName, videoMetadata, separators) {
  log.debug('Processing video metadata...');

  let metadata = await gatherMetadata(videoMetadata, separators);
  // TODO: Maybe just make the metadata a proper class...
  metadata = util.filter(metadata, (k, v) => {
    if (!v) return false;
    return METADATA_FIELDS.includes(k);
  });

  log.debug('Writing mp3 metadata...');
  return new Promise((resolve) => {
    ffMetadata.write(musicFileName, metadata, function (err) {
      if (err) log.warning(err, "Failed to write mp3 metadata.", err);
      resolve(metadata);
    });
  });
};

/**
 * Finalize the MP3 by copying the intermediate mp3 file to its final location in the current directory, renaming it to whatever was specified on the command
 * line if necessary. Verify the tags written on the file.
 * @param {*} metadata Video metadata downloaded from youtube
 * @param {String} intermediateMp3Filename Path to the intermediate mp3 file
 * @param {*} customOutputFile Custom output filename if provided, otherwise defaults to the '{artist} - {title}.mp3'
 * @returns A Promise containing the metadata read from the final MP3
 */
function finalizeMp3(metadata, intermediateMp3Filename, customOutputFile) {
    let outputFileName = './' + metadata.artist + ' - ' + metadata.title + '.mp3';

    if (customOutputFile) {
        outputFileName = sanitize(customOutputFile);
        outputFileName = outputFileName.endsWith('.mp3') ? outputFileName : outputFileName + '.mp3';
    }

    log.debug('Writing final mp3 file: ' + outputFileName);
    try {
        fsExtra.copySync(intermediateMp3Filename, outputFileName);
        fs.unlinkSync(intermediateMp3Filename);
    } catch (err) {
        log.error(err, 'Unable to write ' + outputFileName + '.');
    }

    log.debug('Reading ' + outputFileName);
    return new Promise((resolve) => {
      ffProbe(outputFileName, function (err, data) {
        if (err) log.error(err, 'Unable to read metadata from ' + outputFileName + '.');
        else {
          resolve(data);
        }
      });
    });
}

/**
 * Gather metadata for the song, trying to load it from the Itunes API, or parsing the title. Asks the user to confirm or modify before returning.
 * @param {*} metadata Video metadata downloaded from youtube
 * @param {Array} separators Separators to use when attempting to parse the song title manually
 * @returns A Promise containing the final song metadata, this is guaranteed to be complete as the user is prompted to confirm/override/enter all the fields.
 */
async function gatherMetadata(metadata, separators) {
    const meta = {
        title: metadata.title,
        artist: null,
        album: null,
        genre: null,
        date: null
    };

    /* First try reading from itunes api */
    let result = loadItunesMeta(metadata.title);
    if (!result.success) {
      /* Fallback to parsing video title if no results from itunes */
      log.debug('Failed to resolve \''+ meta.title +'\' in Itunes API, falling back to parsing video title...');
      const parsedInfo = util.parseVideoTitle(metadata.title, separators);
      if (!parsedInfo.success) {
        log.debug('Failed to parse video title \''+ meta.title +'\'');
      } else {
        Object.assign(meta, parsedInfo);
        const searchTerm = meta.artist + ' ' + meta.title;
        /* Try again searching itunes with better title */
        result = loadItunesMeta(searchTerm);
      }
    }

    if (result.success) {
      log.debug('Successfully resolved song in Itunes API: ' + JSON.stringify(result));
      Object.assign(meta, result);
    }

    /* Use discovered values as defaults for user to confirm */
    log.info(chalk.bold('\nEnter song metadata:'));
    const genProperty = (title, defaultVal, expectedType) => {
      let def = { description: title, type: expectedType || 'string', required: true };
      if (!!defaultVal) def.default = defaultVal;
      return def;
    };
    const promptArgs = {
      properties: {
        title: genProperty('Title', meta.title),
        artist: genProperty('Artist', meta.artist),
        album: genProperty('Album', meta.album || 'Single'),
        genre: genProperty('Genre', meta.genre),
        year: genProperty('Year', meta.date, 'number'),
      }
    };
    prompt.message = '';
    prompt.delimiter = ':';
    prompt.start();
    let results = await prompt.get(promptArgs);
    return results;
}

/* Helper that uses the Itunes API to auto-detect song metadata */
/**
 * Attempt to lookup the searchTerm in the ItunesAPI, the first result returned by Itunes that seems to approximately match the video title is returned.
 * @param {String} searchTerm Search term used in API call
 * @returns The result with success flag set to true if successful, otherwise result object with success flag set to false.
 */
function loadItunesMeta(searchTerm) {
    const url = ITUNES_API_BASE + encodeURIComponent(searchTerm);
    log.debug('Searching Itunes for \'' + searchTerm + '\' (' + url + ')');
    let response = request('GET', url);
    
    if (response.statusCode !== 200) {
        log.debug('Itunes API returned ' + response.statusCode + ' status code.');
        return { success: false };
    }

    let results = JSON.parse(response.getBody('utf8')).results || [];

    /* Take the first match */
    let match = results
      .filter(e => {
        if (e.kind !== 'song') return false;
        if (searchTerm.search(new RegExp(e.trackName, 'i')) < 0) return false;
        if (searchTerm.search(new RegExp(e.artistName, 'i')) < 0) return false;
        return true;
      })
      .shift();

    if (!match) {
        log.debug('No matches found on Itunes.');
        return { success: false };
    }

    const result = {
      success: true,
      title: match.trackName,
      artist: match.artistName,
      album: match.collectionName,
      albumUrl: match.artworkUrl100,
      trackNum: match.trackNumber,
      trackCount: match.trackCount,
      genre: match.primaryGenreName,
      date: match.releaseDate.slice(0, 4)
    };
    log.debug('Found a match on Itunes: ' + JSON.stringify(result));
    return result;
}

/**
 * Print the header of the program
 */
function printHeader() {
	log.info(chalk.bold(chalk.redBright("\n__  __             __          __             __              __  ___   ___    ____")));
	log.info(chalk.bold(chalk.yellowBright("\\ \\/ / ___  __ __ / /_ __ __  / /  ___       / /_ ___        /  |/  /  / _ \\  |_  /")));
	log.info(chalk.bold(chalk.greenBright(" \\  / / _ \\/ // // __// // / / _ \\/ -_)     / __// _ \\      / /|_/ /  / ___/ _/_ < ")));
	log.info(chalk.bold(chalk.blueBright(" /_/  \\___/\\_,_/ \\__/ \\_,_/ /_.__/\\__/      \\__/ \\___/     /_/  /_/  /_/    /____/ \n")));
	log.info(chalk.bold(chalk.magentaBright("                                      (" + getVersion() + ")\n")));
  log.info('');
}

/**
 * Parse the package.json and return the current version of the program
 * @returns The current version of the program as a string.
 */
function getVersion() {
  const packageJson = JSON.parse(fs.readFileSync('./package.json'));
  return packageJson.version;
}