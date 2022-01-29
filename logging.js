import chalk from 'chalk';

export class Log {
  constructor(isVerbose) {
    this.isVerbose = isVerbose;
  }

  error(err, msg) {
    if (!msg) msg = err;
    console.log('\n' + chalk.bold(chalk.red('ERROR: ')) + chalk.red(msg));
    console.log(chalk.red(err.stack));
    process.exit(25);
  }

  warning(err, msg) {
    console.log('\n' + chalk.bold(chalk.yellow('WARNING: ')) + chalk.yellow(msg + err.name));
  }

  info(msg) {
    console.log(msg);
  }

  debug(msg) {
    if (this.isVerbose) {
      console.log(msg);
    }
  }
}