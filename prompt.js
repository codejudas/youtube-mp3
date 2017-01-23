const readline = require('readline');

/* Synchronous prompt for user input */
module.exports = function(message, options) {
    options = options || {};
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    var return_val = null;

    rl.setPrompt(message);
    rl.prompt();
    if (options.default) rl.write(String(options.default));

    rl.on('line', (line) => {
        line = line.trim();
        if (options.required && !line) {
            rl.prompt();
        } else {
            rl.close();
            return_val = line.trim();
        }
    });
    require('deasync').loopWhile(function(){ return return_val === null; });
    return return_val;
};
