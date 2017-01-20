/* Return current time in seconds */
module.exports.nowSeconds = function() {
    return Math.floor(Date.now() / 1000);
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
