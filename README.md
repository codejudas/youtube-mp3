# youtube-mp3
A simple command line app to download a youtube video, convert it to an mp3, and write mp3 metadata to the output file.

## Installation
Clone the repository onto your local machine and then run:

```bash
npm install -g
```

Once completed you will be able to invoke the app anywhere on your computer by typing `youtube-mp3`.

## Usage

```bash
youtube-mp3 [options] <youtube_url>

Options:

   -h, --help                  output usage information
   -V, --version               output the version number
   -o, --output <output_file>  output the final mp3 to this file name
   -i, --intermediate          output intermediate downloaded video file
   -l, --low-quality           download the video at low quality settings
   -v, --verbose               print additional information during run, useful for debugging.
```
