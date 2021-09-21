let escapeStringRegexp = require('escape-string-regexp');

/* Return current time in seconds */
module.exports.nowSeconds = function() {
    return Math.floor(Date.now() / 1000);
};

/* Filter an object by its keys or values */
module.exports.filter = function(obj, predicate) {
    var result = {};
    Object.keys(obj).forEach(k => { 
        if (predicate(k, obj[k])) result[k] = obj[k]; 
    });
    return result;
};

/* Pretty print time in mm:ss */
module.exports.prettyTime = function(timeInSeconds) {
    var mins = 0;
    while(timeInSeconds >= 60) {
        mins += 1;
        timeInSeconds -= 60;
    }
    timeInSeconds = Math.round(timeInSeconds);
    out = timeInSeconds < 10 ? '0' + timeInSeconds : '' + timeInSeconds;
    out = mins + ':' + out;
    return out;
};

/* Remove character from ends of string if present */
module.exports.trimString = function(string, character) {
    if (string.startsWith(character)) string = string.slice(1);
    if (string.endsWith(character)) string = string.slice(0,-1);
    return string.trim();
};

/* Remove subtr from string if string ends with substr */
module.exports.removeTrailing = function(string, substring) {
    substring = escapeStringRegexp(substring);
    let regex = new RegExp('[\\S ](' + substring + ')$', 'i');
    if (regex.exec(string)) {
        string = string.slice(0, (-1 * substring.length) + 1);
    }
    return string.trim();
};


/* Return the format with the highest audio bitrate in availableFormats */
module.exports.highestBitrateFormat = function(availableFormats) {
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
module.exports.smallestSizeFormat = function(availableFormats) {
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
module.exports.parseSongName = function(videoDetails) {
    var songName = null;

    const artist = videoDetails.media && videoDetails.media.artist;
    const song = videoDetails.media && videoDetails.media.song;
    const syntheticTitle = artist + ' - ' + song;

    return syntheticTitle || videoDetails.title;
}
