/* Return current time in seconds */
module.exports.nowSeconds = function() {
    return Math.floor(Date.now() / 1000);
};

/* Pretty print time in xm ys */
module.exports.prettyTime = function(timeInSeconds) {
    var mins = 0;
    while(timeInSeconds >= 60) {
        mins += 1;
        timeInSeconds -= 60;
    }
    var out = Math.round(timeInSeconds) + 'sec';
    if (mins > 0) { out = mins + 'min ' + out; }
    return out;
};
