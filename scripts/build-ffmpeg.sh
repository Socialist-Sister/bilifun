#!/bin/bash
# Reproducible single-thread core: FFmpeg 5.1.8 + ffmpeg.wasm 0.12.10 bindings
# + LAME 3.100 (2badea1974ae36cb8312afe99cff1e6b3b5decee).
# Prerequisites: Emscripten 3.1.40, make, and the extracted pinned sources.
# Usage: source emsdk_env.sh; bash build-ffmpeg.sh /absolute/build-directory
set -euo pipefail
BUILD=$(cd "$1" && pwd)
export INSTALL_DIR="../install"
mkdir -p "$BUILD/install/include/lame" "$BUILD/install/lib" "$BUILD/dist"
export CFLAGS="-O3 -I$INSTALL_DIR/include"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-L$INSTALL_DIR/lib"
export FFMPEG_ST=1
cd "$BUILD/lame-2badea1974ae36cb8312afe99cff1e6b3b5decee"
emconfigure sh ./configure CC=emcc CXX=em++ AR=emar RANLIB=emranlib --prefix=/install --host=i686-linux --disable-shared --disable-frontend --disable-analyzer-hooks --disable-dependency-tracking --disable-gtktest
emmake make -j4 CFLAGS=-O3 LDFLAGS=
cp libmp3lame/.libs/libmp3lame.a "$BUILD/install/lib/"
cp include/lame.h "$BUILD/install/include/lame/"
cd "$BUILD/ffmpeg-5.1.8"
# The upstream wasm CLI replaces exit/global cleanup/progress hooks. Keep all
# these corresponding sources with the release; never link GPL video encoders.
mkdir -p src
cp -r "$BUILD/ffmpeg.wasm-0.12.10/src/bind" src/
cp -r "$BUILD/ffmpeg.wasm-0.12.10/src/fftools" src/
emconfigure sh ./configure --prefix=/install --target-os=none --arch=x86_32 --enable-cross-compile --disable-asm --disable-stripping --disable-programs --disable-doc --disable-debug --disable-runtime-cpudetect --disable-autodetect --disable-pthreads --disable-w32threads --disable-os2threads --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc --extra-cflags="$CFLAGS" --extra-cxxflags="$CXXFLAGS" --extra-ldflags="$LDFLAGS" --disable-everything --disable-network --disable-avdevice --disable-postproc --disable-swscale --enable-libmp3lame --enable-protocol=file --enable-demuxer=mov,matroska,aac,mp3,wav --enable-muxer=mp4,matroska,mp3 --enable-decoder=aac,mp3,mp3float,pcm_s16le,pcm_s24le,pcm_f32le --enable-encoder=aac,libmp3lame --enable-parser=aac,mpegaudio,h264,hevc,av1 --enable-bsf=aac_adtstoasc,extract_extradata --enable-filter=aresample,aformat,anull,abuffer,abuffersink
emmake make -j4
emcc -O3 -I. -Isrc/fftools -I"$INSTALL_DIR/include" -L"$INSTALL_DIR/lib" -Llibavcodec -Llibavfilter -Llibavformat -Llibavutil -Llibswresample src/fftools/cmdutils.c src/fftools/ffmpeg.c src/fftools/ffmpeg_filter.c src/fftools/ffmpeg_hw.c src/fftools/ffmpeg_mux.c src/fftools/ffmpeg_opt.c src/fftools/opt_common.c -lavfilter -lavformat -lavcodec -lswresample -lavutil -lmp3lame -sENVIRONMENT=worker -sWASM_BIGINT -sSTACK_SIZE=5MB -sMODULARIZE -sDYNAMIC_EXECUTION=0 -sINITIAL_MEMORY=32MB -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=1GB -sEXPORT_NAME=createFFmpegCore -sEXPORTED_FUNCTIONS=_ffmpeg,_abort,_malloc -sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,setValue,getValue,UTF8ToString,lengthBytesUTF8,stringToUTF8 -lworkerfs.js --pre-js src/bind/ffmpeg/bind.js -o "$BUILD/dist/ffmpeg-core.js"
