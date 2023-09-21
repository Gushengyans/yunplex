'use strict';

import fetch from 'node-fetch'
import plex from 'plex-api'
import Datastore from '@seald-io/nedb'
import readline from 'readline'
import * as fs from 'fs';
import * as path from 'path';
import NodeID3 from 'node-id3'
import flacMetadata from 'metaflac-js'
import dayjs from 'dayjs'
import { machine } from 'os';

const NodeID3tag = NodeID3.Promise
const db = new Datastore({ filename: './music.db', autoload: true });

async function loginYun(phone, password) {
  try {
    const login = await fetch(`http://localhost:3000/login/cellphone?phone=${phone}&password=${password}`)
    const body = await login.json()
    return body
  } catch (error) {
    console.log(error)
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

async function download(url, songInfo, type) {
  // 保存到本地，并保留歌曲的tag信息
  const title = songInfo.name
  const artist = songInfo.artists.map(item => item.name).join(',')
  const album = songInfo.album.name
  const year = dayjs(songInfo.album.publishTime).format('YYYY')
  const trackNumber = songInfo.no
  const imageDown = await fetch(songInfo.album.picUrl);
  const imageBuffer = await imageDown.arrayBuffer(); // 读取为 ArrayBuffer

  // 查看目录下是否有 /artist/album/ 文件夹,如果没有则创建
  const albumPath = path.join(/*path.resolve()*/'/mnt/nas', `./${artist}/${album}`)
  if (!fs.existsSync(albumPath)) fs.mkdirSync(albumPath, { recursive: true });

  // 创建文件夹并下载歌曲
  const songDown = await fetch(url);
  const buffer = await songDown.arrayBuffer(); // 读取为 ArrayBuffer
  // ArrayBuffer 转为 Buffer
  const newBuffer = Buffer.from(buffer);
  // 同步写入文件
  await fs.writeFileSync(path.join(albumPath, `${title}.${type}`), newBuffer);
  // 下载歌词
  const lyricDown = await fetch(`http://localhost:3000/lyric?id=${songInfo.id}`)
  const lyricBody = await lyricDown.json()
  await fs.writeFileSync(path.join(albumPath, `${title}.lrc`), lyricBody.lrc.lyric);

  // 写入tags,判断是否为flac
  const pathName = path.join(albumPath, `${title}.${type}`)
  if (type === 'flac') {
    const flac = new flacMetadata(pathName);
    flac.setTag(`TITLE=${title}`);
    flac.setTag(`ARTIST=${artist}`);
    flac.setTag(`ALBUM=${album}`);
    flac.setTag(`TRACKNUMBER=${trackNumber}`);
    flac.setTag(`YEAR=${year}`);
    flac.setTag(`PERFORMERINFO=${artist}`);
    flac.importPictureFromBuffer(Buffer.from(imageBuffer));

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
          name: 'front cover'
        },
        description: 'cover',
        imageBuffer: Buffer.from(imageBuffer)
      }
    };
    await NodeID3tag.write(tags, pathName);
  }
}

async function setupDB() {
  try {
    const user = await db.findAsync({ type: 'user' })
    // 如果没有用户信息，进入初始化流程
    if (user.length === 0) {
      // 如果没有用户信息，则通过获得用户命令行的信息，登录云音乐
      const phone = await getUserInput('请输入登录网易云的手机号: ');
      const password = await getUserInput('请输入登录网易云的密码: ');
      const user = await loginYun(phone, encodeURIComponent(password));
      // 将用户信息存入数据库
      await db.insertAsync({ type: 'user', user: user.profile, uid: user.profile.userId, cookie: user.cookie, token: user.token, phone, password })
    }
    // 查看数据库中是否有歌单信息
    const playlist = await db.findAsync({ type: 'playlist' })
    // 如果没有歌单信息，则需要同步歌单
    if (playlist.length === 0) {
      const user = await db.findAsync({ type: 'user' })
      console.log('♿️ - file: sync.mjs:20 - main - user[0].uid:', user[0].uid);
      const playlists = await fetch(`http://localhost:3000/user/playlist?uid=${user[0].uid}&limit=50&cookie=${user[0].cookie}`)
      const playlistsBody = await playlists.json()
      console.log('♿️ - file: sync.mjs:20 - main - playlistNames:', playlistsBody);
      const playlistNames = playlistsBody.playlist.map(item => item.name)
      // 将歌单信息存入数据库
      for (let i = 0; i < playlistNames.length; i++) {
        await db.insertAsync({ type: 'playlist', playlistName: playlistNames[i], playlistId: playlistsBody.playlist[i].id, playlistsBody: playlistsBody.playlist[i] })
      }
    }
    // 查看数据库中是否有歌曲信息
    const song = await db.findAsync({ type: 'song' })
    // 如果没有歌曲信息，则需要同步歌曲
    let selectName = ''
    if (song.length === 0) {
      const playlist = await db.findAsync({ type: 'playlist' })
      const playlistNames = playlist.map(item => `${item.playlistId}(${item.playlistName})`)
      selectName = await getUserInput(`请输入需要同步的歌单编号: ${playlistNames.join(',\n')}: `);
      // 根据歌单编号获取歌单详细信息
      const playlistDetail = await fetch(`http://localhost:3000/playlist/detail?id=${selectName}`)
      const playlistDetailBody = await playlistDetail.json()
      //循环获取歌单中的歌曲详细信息,每次 50 个,每个请求之后延迟 500ms
      let songNamesBodySongs = []
      for (let i = 0; i < Math.ceil(playlistDetailBody.playlist.trackIds.length / 50) + 1; i++) {
        const playlistDetailSongs = playlistDetailBody.playlist.trackIds.slice(i * 50, (i + 1) * 50).map(item => item.id).join(',')
        const songNames = await fetch(`http://music.163.com/api/song/detail/?id=&ids=[${playlistDetailSongs}]`)
        const songNamesBody = await songNames.json()
        songNamesBodySongs = songNamesBodySongs.concat(songNamesBody.songs)
        // 每次请求之后延迟 5s
        await new Promise((resolve, reject) => {
          setTimeout(() => {
            resolve()
          }, 1500)
        })
      }

      // 将歌曲信息存入数据库 49061121
      console.log('♿️ - file: sync.mjs:32 - main - songNamesBodySongs:', songNamesBodySongs.length);
      for (let i = 0; i < songNamesBodySongs.length; i++) {
        await db.insertAsync({
          type: 'song', songName: songNamesBodySongs[i]?.name, playlistId: selectName,
          songId: songNamesBodySongs[i]?.id, songNamesBody: songNamesBodySongs[i],
          created_at: Date.now(), updated_at: Date.now(),
          order: i
        })
      }
    }
    // 数据库获取plex信息
    const plexInfo = await db.findAsync({ type: 'plex' })
    if (!plexInfo.length) {
      // 如果没有plex信息，则需要同步歌曲
      const server = await getUserInput('请输入Plex的地址: ');
      const port = await getUserInput('请输入Plex的端口: ');
      const token = await getUserInput('请输入Plex的token: ');
      // 将歌单信息存入数据库
      await db.insertAsync({ type: 'plex', server, port, token })
    }
    return selectName
  } catch (error) {
    console.log(error)
  }
}

async function main() {
  try {
    // 首先 load 数据库
    await db.loadDatabaseAsync()
    // 然后初始化数据库
    const idSelect = await setupDB()

    // 获取选择的歌单id
    let selectName = idSelect
    let selectPlaylist = ''
    if (!idSelect) {
      const playlist = await db.findAsync({ type: 'playlist' })
      const playlistNames = playlist.map(item => `${item.playlistId}(${item.playlistName})`)
      selectName = 49061121/* await getUserInput(`请输入需要同步的歌单编号: ${playlistNames.join(',\n')}: `); */
      selectPlaylist = playlist.filter(item => item.playlistId === Number(selectName))[0].playlistName
    }
    // 获取歌单中最新的100首
    const playlistDetail = await fetch(`https://music.163.com/api/v1/playlist/detail?id=${selectName}`)
    const playlistDetailBody = await playlistDetail.json()
    const playlistDetailSongs = playlistDetailBody.playlist.trackIds.slice(0, 10).map(item => item.id).join(',')
    const songNames = await fetch(`http://music.163.com/api/song/detail/?id=&ids=[${playlistDetailSongs}]`)
    const songNamesBody = await songNames.json()
    const songNamesBodySongs = songNamesBody.songs

    const plexInfo = await db.findAsync({ type: 'plex' })
    let selectPlex = ''
    if (plexInfo.length > 1) {
      const plexNames = plexInfo.map(item => `${item._id}(${item.server})`)
      const select = await getUserInput(`请输入需要同步的Plex编号: ${plexNames.join(',\n')}: `);
      selectPlex = plexInfo.filter(item => String(item._id) === select)[0]
    } else {
      selectPlex = plexInfo[0]
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
        device: 'Windows'
      }
    })
    const res = await client.query('/')
    const machineId = res.MediaContainer.machineIdentifier
    // /* 查找同名歌单 */
    const playlist = await client.query('/playlists')
    const playlistName = playlist.MediaContainer.Metadata.filter(item => item.title === selectPlaylist)
    const syncList = await client.query(`/playlists/${playlistName[0].ratingKey}/items`)
    const titles = syncList.MediaContainer.Metadata.map(item => item.title)
    // 获取歌单中的前100首
    const localSongs = syncList.MediaContainer.Metadata.slice(0, 10)

    //TODO:比较两边的前100首歌曲，如果有不同的，则需要同步(需要按顺序插入本地歌单)
    //songNamesBodySongs
    console.log('♿️ - file: sync.mjs:32 - main - songNamesBodySongs:', songNamesBodySongs.map(item => item.name));
    //localSongs
    console.log('♿️ - file: sync.mjs:32 - main - localSongs:', localSongs.map(item => item.title));
    const yunSongs = songNamesBodySongs.map(item => item.name)
    const plexSongs = localSongs.map(item => item.title)

    let yunLastIndex = 0
    let plexLastIndex = 0
    for (let i = yunSongs.length - 1; i >= 0; i--) {
      const name = yunSongs[i]
      if (plexSongs.includes(name)) {
        yunLastIndex = yunSongs.indexOf(name)
        plexLastIndex = plexSongs.indexOf(name)
        break
      }
    }
    console.log('♿️ - file: sync.mjs:32 - main - yunLastIndex:', yunLastIndex);
    const slicePlexSongs = plexSongs.slice(0, plexLastIndex + 1)
    // 给云音乐的歌曲设置标识，如果plex中有，则不同步
    const user = await db.findAsync({ type: 'user' })
    const syncSongs = await Promise.all(songNamesBodySongs.map(async item => {
      if (slicePlexSongs.includes(item.name)) {
        item.sync = true
      } else {
        item.sync = false
        console.log('♿️ - file: sync.mjs:32 - main - item:', item.name);
        const song = await fetch(`http://localhost:3000/song/url/v1?id=${item.id}&level=jymaster&cookie=${user[0].cookie}`)
        const songBody = await song.json()
        // 下载歌曲
        await download(songBody.data[0].url, item, songBody.data[0].type)
      }
      return item
    }))

    // 命令plex刷新音乐资料库
    // 先获取section的key
    const sections = await client.query('/library/sections')
    const musicSection = sections.MediaContainer.Directory.filter(item => item.type === 'artist')[0]
    await client.query(`/library/sections/${musicSection.key}/refresh`)


    // 等待扫描完毕 1分钟
    await new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve()
      }, 60000)
    })

    // 然后按照顺序插入歌单
    for (let i = 0; i < syncSongs.length; i++) {
      const song = syncSongs[i]
      if (!song.sync) {
        const localsong = await client.find(`/library/sections/${musicSection.key}/search?type=10&title=${encodeURIComponent(song.name)}`)
        await client.putQuery(`/playlists/${playlistName[0].ratingKey}/items?uri=server%3A%2F%2F${machineId}%2Fcom.plexapp.plugins.library%2Flibrary%2Fmetadata%2F${localsong[0].ratingKey}&includeExternalMedia=1&`)
        // 获取 playlistItemID
        const syncListNew = await client.query(`/playlists/${playlistName[0].ratingKey}/items`)
        const playlistItemID = syncListNew.MediaContainer.Metadata.filter(item => item.title.toLocaleLowerCase() === song.name.toLocaleLowerCase())[0]?.playlistItemID ?? 0
        song.playlistItemID = playlistItemID
      }
    }

    for (let i = syncSongs.length - 1; i >= 0; i--) {
      const song = syncSongs[i]
      if (!song.sync && song.playlistItemID) {
        // 挪到最前面
        await client.putQuery(`/playlists/${playlistName[0].ratingKey}/items/${song.playlistItemID}/move`)
      }
    }

  } catch (error) {
    console.log(error)
  }
}
await main()