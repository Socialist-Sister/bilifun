# Generated test tracks

`video.m4s` and `audio.m4s` are two-second synthetic tracks generated for this project, with no Bilibili content. The video is FFmpeg's `testsrc` pattern (320×180, 25 fps, H.264); the audio is a 440 Hz sine wave (44.1 kHz, AAC). Both use fragmented MP4. These fixtures are offered under CC0-1.0; the extension code remains MIT.

`tests/native_media_test.py` contains the generation commands. The binary fixtures are not extension runtime assets and are excluded from the installable extension ZIP. No FFmpeg executable is included in either release ZIP.
