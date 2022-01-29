import escapeStringRegexp from 'escape-string-regexp';

/* Return current time in seconds */
export function nowSeconds() {
    return Math.floor(Date.now() / 1000);
};

/* Filter an object by its keys or values */
export function filter(obj, predicate) {
    let result = {};
    Object.keys(obj).forEach(k => { 
        if (predicate(k, obj[k])) result[k] = obj[k]; 
    });
    return result;
};

/* Pretty print time in mm:ss */
export function prettyTime(timeInSeconds) {
    let mins = 0;
    while(timeInSeconds >= 60) {
        mins += 1;
        timeInSeconds -= 60;
    }
    timeInSeconds = Math.round(timeInSeconds);
    let out = timeInSeconds < 10 ? '0' + timeInSeconds : '' + timeInSeconds;
    out = mins + ':' + out;
    return out;
};

/* Remove character from ends of string if present */
export function trimString(string, character) {
    if (string.startsWith(character)) string = string.slice(1);
    if (string.endsWith(character)) string = string.slice(0,-1);
    return string.trim();
};

/* Remove subtr from string if string ends with substr */
export function removeTrailing(string, substring) {
    substring = escapeStringRegexp(substring);
    let regex = new RegExp('[\\S ](' + substring + ')$', 'i');
    if (regex.exec(string)) {
        string = string.slice(0, (-1 * substring.length) + 1);
    }
    return string.trim();
};


/* Return the format with the highest audio bitrate in availableFormats */
export function highestBitrateFormat(availableFormats) {
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
};

/* Return the format with the highest audio bitrate in availableFormats */
export function smallestSizeFormat(availableFormats) {
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

/* Try to guess the name of the song */
export function parseSongName(videoDetails) {
    var songName = null;

    const artist = videoDetails.media && videoDetails.media.artist;
    const song = videoDetails.media && videoDetails.media.song;
    const syntheticTitle = artist + ' - ' + song;

    return syntheticTitle || videoDetails.title;
}

/* Parses the video title to extract song title and artist, trim unnecessary info */
export function parseVideoTitle(videoTitle, separators) {
    let meta = {success: false};

    const escapedSeps = separators.map((e) => escapeStringRegexp(e));
    separators = separators.join('|');
    const titleRegex = new RegExp('([\\S ]+) (' + escapedSeps + ') ([\\S ]+)');

    const songTitleMatch = titleRegex.exec(videoTitle);
    if (songTitleMatch) {
        meta.artist = songTitleMatch[1].trim();
        meta.title = songTitleMatch[3].trim();

        meta.title = util.trimString(meta.title, '"');
        meta.title = util.trimString(meta.title, '\'');

        meta.title = util.removeTrailing(meta.title, '(official video)');
        meta.title = util.removeTrailing(meta.title, 'official video');
        meta.title = util.removeTrailing(meta.title, 'high quality');
        meta.title = util.removeTrailing(meta.title, 'lyrics');

        meta.success = true;
    }
    return meta;
}