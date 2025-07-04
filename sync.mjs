'use strict';

import fetch from 'node-fetch';
import plex from 'plex-api';
import Datastore from '@seald-io/nedb';
import readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import NodeID3 from 'node-id3';
import flacMetadata from 'metaflac-js';
import dayjs from 'dayjs';
import pkg from 'NeteaseCloudMusicApi';
const { login_status, lyric_new, user_playlist, song_url_v1 } = pkg;

const NodeID3tag = NodeID3.Promise;
const db = new Datastore({ filename: './music.db', autoload: true });

// docker化后，需要读取环境变量
const SCAN_INTERVAL = process.env.SCAN_INTERVAL ?? 30;
const SONG_LIMIT = process.env.SONG_LIMIT ?? 10;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? '/mnt/nas';
const PLAYLIST = process.env.PLAYLIST;
const PLEX_SERVER = process.env.PLEX_SERVER;
const PLEX_PORT = process.env.PLEX_PORT;
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const PLEX_SECTION = process.env.PLEX_SECTION ?? '音乐';
const YUN_COOKIE = process.env.YUN_COOKIE;
const LEVEL_ENUM = {
    标准: 'standard',
    较高: 'higher',
    极高: 'exhigh',
    无损: 'lossless',
    'Hi-Res': 'hires',
    高清环绕声: 'jyeffect',
    沉浸环绕声: 'sky',
    超清母带: 'jymaster',
};
const LEVEL = LEVEL_ENUM[process.env?.LEVEL] ?? 'jymaster'; // 默认使用超清母带

async function checkCookieValid(cookie) {
    try {
        const res = await login_status({ cookie: cookie });
        const data = res?.body?.data;
        if (data?.code !== 200) {
            console.warn('⚠️ 网易云 cookie 可能已失效，请重新抓取 YUN_COOKIE');
        } else {
            console.log('✅ 网易云 cookie 正常');
            // 将 cookie 存入数据库
            await db.insertAsync({
                type: 'user',
                user: data?.profile,
                uid: data?.profile?.userId,
                cookie: YUN_COOKIE,
                token: data?.token,
            });
        }
    } catch (e) {
        console.warn('⚠️ 无法验证网易云 cookie 状态', e.message);
    }
}

async function getUserInput(prompt) {
    return new Promise((resolve) => {
        const readlines = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        readlines.question(prompt, (input) => {
            readlines.close();
            resolve(input);
        });
    });
}

async function download(url, songInfo, type, cookie) {
    // 保存到本地，并保留歌曲的tag信息
    const title = songInfo.name;
    const artist = songInfo.artists.map((item) => item.name).join('&');
    const album = songInfo.album.name;
    const year = dayjs(songInfo.album.publishTime).format('YYYY');
    const trackNumber = songInfo.no;
    const imageDown = await fetch(songInfo.album.picUrl);
    const imageBuffer = await imageDown.arrayBuffer(); // 读取为 ArrayBuffer

    // 查看目录下是否有 /artist/album/ 文件夹,如果没有则创建
    const albumPath = path.join(DOWNLOAD_DIR, `/${artist}/${album}`);
    if (!fs.existsSync(albumPath)) fs.mkdirSync(albumPath, { recursive: true });

    // 创建文件夹并下载歌曲
    const songDown = await fetch(url);
    const buffer = await songDown.arrayBuffer(); // 读取为 ArrayBuffer
    // ArrayBuffer 转为 Buffer
    const newBuffer = Buffer.from(buffer);
    // 同步写入文件
    await fs.writeFileSync(path.join(albumPath, `${title}.${type}`), newBuffer);
    // 下载歌词
    const lyricDownNew = await lyric_new({ id: songInfo.id, cookie: cookie });
    const lyricBodyNew = lyricDownNew.body;
    await fs.writeFileSync(path.join(albumPath, `${title}.lrc`), lyricBodyNew?.lrc?.lyric);

    // 写入tags,判断是否为flac
    const pathName = path.join(albumPath, `${title}.${type}`);
    if (type === 'flac') {
        const flac = new flacMetadata(pathName);
        flac.setTag(`TITLE=${title}`);
        flac.setTag(`ARTIST=${artist}`);
        flac.setTag(`ALBUM=${album}`);
        flac.setTag(`TRACKNUMBER=${trackNumber}`);
        flac.setTag(`YEAR=${year}`);
        flac.setTag(`PERFORMERINFO=${artist}`);

        const MAX_SIZE = 16777215; // 16.7 MB in bytes
        if (imageBuffer && imageBuffer.byteLength <= MAX_SIZE) {
            console.log(' imageBuffer.byteLength', imageBuffer.byteLength);
            flac.importPictureFromBuffer(Buffer.from(imageBuffer));
        } else {
            console.warn('Image is too large. Skipping adding image to FLAC.');
        }

        await flac.save();
    } else {
        const tags = {
            title: title,
            artist: artist,
            album: album,
            trackNumber: trackNumber,
            year: year,
            performerInfo: artist,
            image: {
                mime: 'jpeg',
                type: {
                    id: 3,
                    name: 'front cover',
                },
                description: 'cover',
                imageBuffer: Buffer.from(imageBuffer),
            },
        };
        await NodeID3tag.write(tags, pathName);
    }
}

async function setupDB() {
    try {
        const user = await db.findAsync({ type: 'user' });
        // 如果没有用户信息，进入初始化流程
        if (user.length === 0) {
            const yunCookie = YUN_COOKIE ?? (await getUserInput('请输入网易云音乐的 cookie: '));
            await checkCookieValid(yunCookie);
        }

        // 查看数据库中是否有歌单信息
        const playlist = await db.findAsync({ type: 'playlist' });
        // 如果没有歌单信息，则需要同步歌单
        if (playlist.length === 0) {
            const user = await db.findAsync({ type: 'user' });
            const playlists = await user_playlist({
                uid: user[0].uid,
                limit: 50,
                cookie: user[0].cookie,
            });
            const playlistsBody = playlists.body;
            const playlistNames = playlistsBody.playlist.map((item) => item.name);
            // 将歌单信息存入数据库
            for (let i = 0; i < playlistNames.length; i++) {
                await db.insertAsync({
                    type: 'playlist',
                    playlistName: playlistNames[i],
                    playlistId: playlistsBody.playlist[i].id,
                    playlistsBody: playlistsBody.playlist[i],
                });
            }
        }

        // // 查看数据库中是否有歌曲信息
        // const song = await db.findAsync({ type: 'song' });
        // // 如果没有歌曲信息，则需要同步歌曲
        // let selectName = '';
        // if (song.length === 0) {
        //     const user = await db.findAsync({ type: 'user' });
        //     const playlist = await db.findAsync({ type: 'playlist' });
        //     const playlistNames = playlist.map(item => `${item.playlistId}(${item.playlistName})`);
        //     selectName = PLAYLIST ?? (await getUserInput(`请输入需要同步的歌单编号: ${playlistNames.join(',\n')}: `));
        //     // 根据歌单编号获取歌单详细信息
        //     const playlistDetail = await playlist_detail({ id: selectName, cookie: user[0].cookie });
        //     const playlistDetailBody = playlistDetail.body;
        //     //循环获取歌单中的歌曲详细信息,每次 50 个,每个请求之后延迟 500ms
        //     let songNamesBodySongs = [];
        //     for (let i = 0; i < Math.ceil(playlistDetailBody.playlist.trackIds.length / 50) + 1; i++) {
        //         const playlistDetailSongs = playlistDetailBody.playlist.trackIds
        //             .slice(i * 50, (i + 1) * 50)
        //             .map(item => item.id)
        //             .join(',');
        //         const songNames = await fetch(`http://music.163.com/api/song/detail/?id=&ids=[${playlistDetailSongs}]`);
        //         const songNamesBody = await songNames.json();
        //         songNamesBodySongs = songNamesBodySongs.concat(songNamesBody.songs);
        //         // 每次请求之后延迟 5s
        //         await new Promise((resolve, reject) => {
        //             setTimeout(() => {
        //                 resolve();
        //             }, 1500);
        //         });
        //     }
        //     // 将歌曲信息存入数据库
        //     console.log('♿️ - file: sync.mjs:32 - main - songNamesBodySongs:', songNamesBodySongs.length);
        //     for (let i = 0; i < songNamesBodySongs.length; i++) {
        //         await db.insertAsync({
        //             type: 'song',
        //             songName: songNamesBodySongs[i]?.name,
        //             playlistId: selectName,
        //             songId: songNamesBodySongs[i]?.id,
        //             songNamesBody: songNamesBodySongs[i],
        //             created_at: Date.now(),
        //             updated_at: Date.now(),
        //             order: i,
        //         });
        //     }
        // }

        // 数据库获取plex信息
        const plexInfo = await db.findAsync({ type: 'plex' });
        if (!plexInfo.length) {
            // 如果没有plex信息，则需要同步歌曲
            const server = PLEX_SERVER ?? (await getUserInput('请输入Plex的地址: '));
            const port = PLEX_PORT ?? (await getUserInput('请输入Plex的端口: '));
            const token = PLEX_TOKEN ?? (await getUserInput('请输入Plex的token: '));
            const section = PLEX_SECTION ?? (await getUserInput('请输入Plex的音乐库名称: '));
            // 将歌单信息存入数据库
            await db.insertAsync({ type: 'plex', server, port, token, section });
        }

        return true;
    } catch (error) {
        console.log(error);
    }
}

async function sync(client, selectName, machineId, selectPlaylist, section) {
    console.log('♿️ - file: sync.mjs:32 - main - sync - 开始同步');
    // 检查 cookie 是否有效
    const user = await db.findAsync({ type: 'user' });
    await checkCookieValid(user[0]?.cookie);
    // 初始化获取两边歌单
    const playlistDetail = await fetch(`https://music.163.com/api/v1/playlist/detail?id=${selectName}`);
    const playlistDetailBody = await playlistDetail.json();
    const playlistDetailSongs = playlistDetailBody.playlist.trackIds
        .slice(0, SONG_LIMIT)
        .map((item) => item.id)
        .join(',');
    const songNames = await fetch(`http://music.163.com/api/song/detail/?id=&ids=[${playlistDetailSongs}]`);
    const songNamesBody = await songNames.json();
    const songNamesBodySongs = songNamesBody.songs;

    /* 查找同名歌单 */
    const playlist = await client.query('/playlists');
    console.log('♿️ - file: sync.mjs:32 - main - sync - playlist:', playlist.MediaContainer.Metadata);
    const playlistName = playlist.MediaContainer.Metadata.filter((item) => item.title === selectPlaylist);
    if (!playlistName.length) {
        console.log('♿️ - file: sync.mjs:32 - main - sync - 未找到同名歌单');
        return;
    }

    // 获取歌单中的前10首
    const syncList = await client.query(`/playlists/${playlistName[0].ratingKey}/items`);
    // 获取歌单中的前10首
    const localSongs = syncList?.MediaContainer?.Metadata?.slice(0, SONG_LIMIT) ?? [];
    if (!localSongs.length) {
        console.log('♿️ - file: sync.mjs:32 - main - sync - 本地歌单为空，跳过同步');
        return;
    }

    //比较两边的前10首歌曲，如果有不同的，则需要同步(需要按顺序插入本地歌单)
    const yunSongs = songNamesBodySongs.map((item) => item.name);
    const plexSongs = localSongs.map((item) => item.title);
    //songNamesBodySongs
    console.log('♿️ - file: sync.mjs:32 - main - songNamesBodySongs:', yunSongs);
    //localSongs
    console.log('♿️ - file: sync.mjs:32 - main - localSongs:', plexSongs);

    let yunLastIndex = 0;
    let plexLastIndex = 0;
    for (let i = yunSongs.length - 1; i >= 0; i--) {
        const name = yunSongs[i];
        if (plexSongs.includes(name)) {
            yunLastIndex = yunSongs.indexOf(name);
            plexLastIndex = plexSongs.indexOf(name);
            break;
        }
    }
    console.log('♿️ - file: sync.mjs:32 - main - yunLastIndex:', yunLastIndex);
    const slicePlexSongs = plexSongs.slice(0, plexLastIndex + 1);

    // 给云音乐的歌曲设置标识，如果plex中有，则不同步
    const syncSongs = await Promise.all(
        songNamesBodySongs.map(async (item) => {
            if (slicePlexSongs.includes(item.name)) {
                item.sync = true;
            } else {
                item.sync = false;
                console.log('♿️ - file: sync.mjs:32 - main - item:', item.name);
                let song = {};
                song = await song_url_v1({ id: item.id, level: LEVEL, cookie: user[0]?.cookie });
                let songBody = song.body;
                if (songBody.data[0].type !== 'flac' && songBody.data[0].type !== 'mp3') {
                    song = await song_url_v1({ id: item.id, level: 'hires', cookie: user[0]?.cookie });
                    songBody = song.body;
                }
                // 下载歌曲
                await download(songBody.data[0].url, item, songBody.data[0].type, user[0]?.cookie);
            }
            return item;
        }),
    );

    // 命令plex刷新音乐资料库
    // 先获取section的key
    const sections = await client.query('/library/sections');
    const musicSections = sections?.MediaContainer?.Directory;
    const musicSection = musicSections
        ?.filter((item) => item?.type === 'artist')
        .find((item) => item?.title === (section || PLEX_SECTION));
    if (!musicSection) {
        console.log('♿️ - file: sync.mjs:32 - main - 未找到音乐库');
        return;
    }
    await client.query(`/library/sections/${musicSection.key}/refresh`);

    // 等待扫描完毕 1分钟
    await new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve();
        }, 60000);
    });

    // 然后按照顺序插入歌单
    for (let i = 0; i < syncSongs.length; i++) {
        const song = syncSongs[i];
        if (!song.sync) {
            const localsong = await client.find(
                `/library/sections/${musicSection.key}/search?type=10&title=${encodeURIComponent(song.name)}`,
            );
            const findSong =
                localsong.find(
                    (item) =>
                        item.title.toLowerCase() === song.name.toLowerCase() &&
                        item.grandparentTitle.toLowerCase() ===
                            song.artists.map((item) => item.name.toLowerCase()).join('&') &&
                        item.parentTitle.toLowerCase() === song.album.name.toLowerCase(),
                ) ?? localsong[0];
            await client.putQuery(
                `/playlists/${playlistName[0].ratingKey}/items?uri=server%3A%2F%2F${machineId}%2Fcom.plexapp.plugins.library%2Flibrary%2Fmetadata%2F${findSong.ratingKey}&includeExternalMedia=1&`,
            );
            // 获取 playlistItemID
            const syncListNew = await client.query(`/playlists/${playlistName[0].ratingKey}/items`);
            const playlistItemID =
                syncListNew.MediaContainer.Metadata.filter((item) => item.title === song.name)[0]?.playlistItemID ?? 0;
            song.playlistItemID = playlistItemID;
            console.log(song.name, playlistItemID);
        }
    }

    // 倒着插回去，这样才能保持顺序
    for (let i = syncSongs.length - 1; i >= 0; i--) {
        const song = syncSongs[i];
        if (!song.sync && (song.playlistItemID === 0 || song.playlistItemID)) {
            // 挪到最前面
            await client.putQuery(`/playlists/${playlistName[0].ratingKey}/items/${song.playlistItemID}/move`);
        }
    }

    console.log('♿️ - file: sync.mjs:32 - main - sync - 同步完成');
}

async function main() {
    try {
        // 首先 load 数据库
        await db.loadDatabaseAsync();
        // 然后初始化数据库
        await setupDB();

        // 获取选择的歌单id
        let selectName = '';
        let selectPlaylist = '';

        const playlist = await db.findAsync({ type: 'playlist' });
        const playlistNames = playlist.map((item) => `${item.playlistId}(${item.playlistName})`);
        if (playlist.length === 1) {
            selectName = playlist[0].playlistId;
            selectPlaylist = playlist[0].playlistName;
        }
        // 先读参数，如果没有参数，则需要用户输入
        selectName =
            process.argv[2] ??
            PLAYLIST ??
            (await getUserInput(`请输入需要同步的歌单编号: ${playlistNames.join(',\n')}: `));
        console.log('♿️ - file: sync.mjs:32 - main - selectName:', selectName);
        selectPlaylist = playlist.filter((item) => item.playlistId === Number(selectName))[0].playlistName;

        // 初始化 Plex
        const plexInfo = await db.findAsync({ type: 'plex' });
        let selectPlex = '';
        if (plexInfo.length > 1) {
            const plexNames = plexInfo.map((item) => `${item._id}(${item.server})`);
            const select = await getUserInput(`请输入需要同步的Plex服务器编号: ${plexNames.join(',\n')}: `);
            selectPlex = plexInfo.filter((item) => String(item._id) === select)[0];
        } else {
            selectPlex = plexInfo[0];
        }
        const client = new plex({
            hostname: selectPlex.server,
            port: selectPlex.port,
            token: selectPlex.token,
            options: {
                identifier: 'com.plexapp.plugins.library',
                product: 'Plex Web',
                version: '3.0.1',
                deviceName: 'Plex Web (Chrome)',
                platform: 'Chrome',
                platformVersion: '37.0',
                device: 'Windows',
            },
        });
        const res = await client.query('/');
        const machineId = res.MediaContainer.machineIdentifier;

        // 每30分钟执行一次同步函数
        const intervalInMilliseconds = SCAN_INTERVAL * 60 * 1000;
        // 执行一次同步函数
        await sync(client, selectName, machineId, selectPlaylist, selectPlex?.section);
        // 设置定时任务
        setInterval(async () => {
            await sync(client, selectName, machineId, selectPlaylist, selectPlex?.section);
        }, intervalInMilliseconds);
    } catch (error) {
        console.log('e', error);
    }
}

await main();
