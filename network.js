/* ========================================================
   WORM ARENA - ÇOK OYUNCULU AĞ MOTORU (WebRTC / PeerJS)
   Sunucu kurmaya gerek kalmadan internet veya Wi-Fi üzerinden
   arkadaşların aynı odaya katılarak eş zamanlı oynamasını sağlar.
   ======================================================== */

class NetworkManager {
  constructor(game) {
    this.game = game;
    this.peer = null;
    this.isHost = false;
    this.isMultiplayer = false;
    this.roomCode = null;
    this.connections = new Map(); // peerId -> DataConnection
    this.lobbyPlayers = new Map(); // peerId -> { id, name, skinId, hatId, isHost }
    this.remotePlayers = new Map(); // peerId -> Worm nesnesi
    this.hostConn = null; // Client için: host DataConnection
    this.myPeerId = null;

    // Input gönderme kısıtlayıcı (bant genişliği tasarrufu)
    this.lastSentAngle = -999;
    this.lastSentBoosting = null;
    this.lastInputTime = 0;

    // Callback fonksiyonları
    this.onPlayerJoined = null;
    this.onPlayerLeft = null;
    this.onRoomReady = null;
    this.onLobbyUpdated = null;
    this.onError = null;
  }

  // Rastgele 4 haneli kolay oda kodu üret (örn: 7842)
  generateRoomCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  // STUN & TURN Sunucu Listesi (NAT arkasındaki, Mobil 4G/5G ve Farklı Ağlardaki Oyuncuların Doğrudan veya Röle ile Kesintisiz Bağlanması için)
  getIceServers() {
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      {
        urls: [
          'turn:global.relay.metered.ca:80',
          'turn:global.relay.metered.ca:443',
          'turn:global.relay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelay',
        credential: 'openrelay'
      }
    ];
  }

  // ==================== 1. ODA KUR (HOST OL) ====================
  createRoom(customCode = null) {
    return new Promise((resolve, reject) => {
      this.disconnect();

      this.isHost = true;
      this.isMultiplayer = true;
      this.roomCode = customCode || this.generateRoomCode();
      const peerId = `wormarena-${this.roomCode}`;

      if (typeof Peer === 'undefined') {
        if (window.showInGameAlert) {
          window.showInGameAlert('Çok oyunculu ağ kütüphanesi yüklenemedi. İnternet bağlantınızı kontrol edin.', 'warning', '⚠️ BAĞLANTI HATASI');
        }
        reject(new Error('PeerJS not loaded'));
        return;
      }

      this.peer = new Peer(peerId, {
        debug: 1,
        config: {
          iceServers: this.getIceServers(),
          sdpSemantics: 'unified-plan'
        }
      });

      this.peer.on('open', (id) => {
        this.myPeerId = id;
        console.log('Oda kuruldu! Kod:', this.roomCode);

        // Host'un kendi lobi kaydını oluştur
        this.lobbyPlayers.clear();
        this.remotePlayers.clear();
        this.connections.clear();

        if (this.onRoomReady) this.onRoomReady(this.roomCode);
        if (this.onLobbyUpdated) this.onLobbyUpdated(this.getLobbyList(), this.roomCode);

        resolve(this.roomCode);
      });

      this.peer.on('connection', (conn) => {
        this.handleIncomingConnection(conn);
      });

      this.peer.on('error', (err) => {
        console.error('Peer error:', err);
        if (err.type === 'unavailable-id') {
          // Kod çakıştıysa yeni bir kod ile dene
          this.createRoom(this.generateRoomCode()).then(resolve).catch(reject);
        } else {
          if (window.showInGameAlert) {
            window.showInGameAlert('Oda kurulamadı. Lütfen internet bağlantınızı kontrol edip tekrar deneyin.', 'warning', '⚠️ ODA HATASI');
          }
          if (this.onError) this.onError(err);
          reject(err);
        }
      });
    });
  }

  // Gelen arkadaş bağlantısını karşıla (Host tarafı)
  handleIncomingConnection(conn) {
    conn.on('open', () => {
      this.connections.set(conn.peer, conn);
      console.log('Arkadaş bağlandı:', conn.peer);
    });

    conn.on('data', (data) => {
      this.handleClientMessage(conn.peer, data);
    });

    conn.on('close', () => {
      console.log('Arkadaş ayrıldı:', conn.peer);
      this.connections.delete(conn.peer);
      this.lobbyPlayers.delete(conn.peer);
      this.removeRemotePlayer(conn.peer);

      // Lobi modundaysak güncel oyuncu listesini herkese yay
      if (this.game.state !== 'PLAYING') {
        this.broadcastLobbyState();
      }
      if (this.onPlayerLeft) this.onPlayerLeft(conn.peer);
    });

    conn.on('error', (err) => {
      console.error('İstemci bağlantı hatası:', conn.peer, err);
    });
  }

  // Host: Tüm bağlı istemcilere veri gönder
  broadcast(data) {
    this.connections.forEach((conn) => {
      if (conn && conn.open) {
        try {
          conn.send(data);
        } catch (e) {
          console.warn('Yayın gönderme hatası:', e);
        }
      }
    });
  }

  // Host: Lobideki tüm oyuncuların listesini derle
  getLobbyList() {
    const hostName = (this.game && this.game.getPlayerName) ? this.game.getPlayerName() : 'Oda Sahibi';
    const hostSkin = (this.game && this.game.getSelectedSkinId) ? this.game.getSelectedSkinId() : 'white_king';
    const hostHat = (this.game && this.game.equippedHat) ? this.game.equippedHat : 'none';

    const list = [
      { id: 'host', name: hostName, isHost: true, skinId: hostSkin, hatId: hostHat }
    ];

    this.lobbyPlayers.forEach((p) => {
      list.push(p);
    });

    return list;
  }

  // Host: Lobideki oyuncu listesini hem kendi ekranında güncelle hem istemcilere yay
  broadcastLobbyState() {
    const list = this.getLobbyList();
    if (this.onLobbyUpdated) {
      this.onLobbyUpdated(list, this.roomCode);
    }

    this.broadcast({
      type: 'LOBBY_STATE',
      roomCode: this.roomCode,
      players: list
    });
  }

  // Client'tan Host'a gelen mesajları işle
  handleClientMessage(peerId, data) {
    if (!data || !data.type) return;

    if (data.type === 'PLAYER_HELLO') {
      const pInfo = {
        id: peerId,
        name: (data.name || 'Misafir').substring(0, 14),
        skinId: data.skinId || 'white_king',
        hatId: data.hatId || 'none',
        isHost: false
      };
      this.lobbyPlayers.set(peerId, pInfo);

      // Ses çal
      if (typeof sounds !== 'undefined' && sounds.playSpecial) {
        sounds.playSpecial();
      }

      // Oyun zaten başlamışsa bu oyuncuyu hemen canlı arenaya dahil et (Hot-Join)
      if (this.game.state === 'PLAYING') {
        const skin = (typeof SKINS !== 'undefined' && SKINS.find(s => s.id === pInfo.skinId)) || SKINS[0];
        const spawnX = Math.round(this.game.worldWidth / 2 + (Math.random() - 0.5) * 800);
        const spawnY = Math.round(this.game.worldHeight / 2 + (Math.random() - 0.5) * 800);
        const worm = new Worm(spawnX, spawnY, pInfo.name, skin, false);
        worm.peerId = peerId;
        worm.hat = pInfo.hatId;
        this.remotePlayers.set(peerId, worm);

        const conn = this.connections.get(peerId);
        if (conn && conn.open) {
          conn.send({
            type: 'GAME_START',
            worldWidth: this.game.worldWidth,
            worldHeight: this.game.worldHeight,
            foods: this.game.foods.map(f => ({ x: Math.round(f.x), y: Math.round(f.y), type: f.type })),
            mySpawn: { x: spawnX, y: spawnY, angle: 0 },
            players: this.getLobbyList()
          });
        }
      } else {
        // Lobi bekleme modundayız; listeyi güncelle ve herkese bildir
        this.broadcastLobbyState();
      }
    } else if (data.type === 'PLAYER_INPUT') {
      const worm = this.remotePlayers.get(peerId);
      if (worm && !worm.isDead) {
        worm.targetAngle = data.targetAngle;
        worm.isBoosting = !!data.isBoosting;
      }
    } else if (data.type === 'PLAYER_RESPAWN') {
      // Ölen istemci tekrar canlanmak istediğinde
      const pInfo = this.lobbyPlayers.get(peerId);
      if (pInfo) {
        const skin = (typeof SKINS !== 'undefined' && SKINS.find(s => s.id === pInfo.skinId)) || SKINS[0];
        const rx = Math.round(this.game.worldWidth / 2 + (Math.random() - 0.5) * 800);
        const ry = Math.round(this.game.worldHeight / 2 + (Math.random() - 0.5) * 800);
        const worm = new Worm(rx, ry, pInfo.name, skin, false);
        worm.peerId = peerId;
        worm.hat = pInfo.hatId;
        this.remotePlayers.set(peerId, worm);

        const conn = this.connections.get(peerId);
        if (conn && conn.open) {
          conn.send({
            type: 'RESPAWN_ACK',
            x: rx,
            y: ry
          });
        }
      }
    }
  }

  // ==================== 2. ODAYI BAŞLAT (HOST TETİKLER) ====================
  // Oda kuran kişi 'ARENAYI BAŞLAT' butonuna bastığında çağrılır.
  // Tüm odadaki oyuncular aynı saniyede oyuna başlar.
  startRoomGame(includeBots = true) {
    if (!this.isHost) return;

    const list = this.getLobbyList();
    const count = list.length;
    const centerX = this.game.worldWidth / 2;
    const centerY = this.game.worldHeight / 2;
    const spawnRadius = Math.min(500, 200 + count * 45);

    // Host dünyasında yiyecekleri tazele
    this.game.initFoods(600);

    // Tüm oyuncular için merkez etrafında düzenli başlangıç noktaları oluştur
    const spawns = {};
    list.forEach((p, idx) => {
      const angle = (idx / count) * Math.PI * 2;
      const x = Math.round(centerX + Math.cos(angle) * spawnRadius);
      const y = Math.round(centerY + Math.sin(angle) * spawnRadius);
      const faceAngle = Number((angle + Math.PI).toFixed(2));
      spawns[p.id] = { x, y, angle: faceAngle };
    });

    // Host tarafında uzaktaki arkadaşlar için Worm nesnelerini kur
    this.remotePlayers.clear();
    this.lobbyPlayers.forEach((p, peerId) => {
      const skin = (typeof SKINS !== 'undefined' && SKINS.find(s => s.id === p.skinId)) || SKINS[0];
      const sp = spawns[peerId] || { x: centerX, y: centerY, angle: 0 };
      const worm = new Worm(sp.x, sp.y, p.name, skin, false);
      worm.peerId = peerId;
      worm.hat = p.hatId || 'none';
      worm.angle = sp.angle;
      worm.targetAngle = sp.angle;
      this.remotePlayers.set(peerId, worm);
    });

    // Host'un kendi solucanını başlat
    const hostSp = spawns['host'] || { x: centerX, y: centerY, angle: 0 };
    this.game.startMultiplayerHostGame(includeBots, hostSp.x, hostSp.y, hostSp.angle);

    // Tüm bağlı istemcilere GAME_START paketi yayınla
    const payload = {
      type: 'GAME_START',
      roomCode: this.roomCode,
      worldWidth: this.game.worldWidth,
      worldHeight: this.game.worldHeight,
      foods: this.game.foods.map(f => ({ x: Math.round(f.x), y: Math.round(f.y), type: f.type })),
      spawns: spawns,
      players: list
    };

    this.broadcast(payload);
  }

  // ==================== 3. ODAYA KATIL (CLIENT OL) ====================
  joinRoom(code) {
    return new Promise((resolve, reject) => {
      this.disconnect();

      this.isHost = false;
      this.isMultiplayer = true;
      this.roomCode = code.trim();
      const targetHostId = `wormarena-${this.roomCode}`;

      if (typeof Peer === 'undefined') {
        if (window.showInGameAlert) {
          window.showInGameAlert('Çok oyunculu ağ kütüphanesi yüklenemedi. İnternet bağlantınızı kontrol edin.', 'warning', '⚠️ BAĞLANTI HATASI');
        }
        reject(new Error('PeerJS not loaded'));
        return;
      }

      this.peer = new Peer({
        debug: 1,
        config: {
          iceServers: this.getIceServers(),
          sdpSemantics: 'unified-plan'
        }
      });

      let connTimeout = setTimeout(() => {
        if (!this.hostConn || !this.hostConn.open) {
          if (window.showInGameAlert) {
            window.showInGameAlert('Odaya bağlanma zaman aşımına uğradı. Oda kodunu kontrol edin veya oda sahibinin açık olduğundan emin olun.', 'warning', '⚠️ BAĞLANTI ZAMAN AŞIMI');
          }
          this.disconnect();
          reject(new Error('Bağlantı zaman aşımı'));
        }
      }, 14000);

      this.peer.on('open', (id) => {
        this.myPeerId = id;
        console.log('İstemci Peer oluşturuldu:', id);

        // Güvenilir (reliable: true) veri kanalı ile host'a bağlan
        const conn = this.peer.connect(targetHostId, { reliable: true });

        conn.on('open', () => {
          clearTimeout(connTimeout);
          this.hostConn = conn;
          console.log('Odaya başarıyla bağlandı!');

          // Host'a profil ve kostüm bilgilerini gönder
          const playerName = (this.game && this.game.getPlayerName) ? this.game.getPlayerName() : 'Oyuncu';
          const skinId = (this.game && this.game.getSelectedSkinId) ? this.game.getSelectedSkinId() : 'white_king';
          const hatId = (this.game && this.game.equippedHat) ? this.game.equippedHat : 'none';

          conn.send({
            type: 'PLAYER_HELLO',
            name: playerName,
            skinId: skinId,
            hatId: hatId
          });

          resolve(this.roomCode);
        });

        conn.on('data', (data) => {
          this.handleHostMessage(data);
        });

        conn.on('close', () => {
          clearTimeout(connTimeout);
          if (window.showInGameAlert) {
            window.showInGameAlert('Oda sahibi oyunu kapattı veya bağlantı koptu.', 'warning', '⚠️ BAĞLANTI KOPTU');
          }
          this.game.returnToMenu();
        });

        conn.on('error', (err) => {
          clearTimeout(connTimeout);
          console.error('Bağlantı hatası:', err);
          if (window.showInGameAlert) {
            window.showInGameAlert('Oda sahibine bağlanırken hata oluştu.', 'warning', '⚠️ BAĞLANTI HATASI');
          }
          reject(err);
        });
      });

      this.peer.on('error', (err) => {
        clearTimeout(connTimeout);
        console.error('Odaya bağlanılamadı:', err);
        let msg = 'Odaya bağlanılamadı. Kodun doğruluğunu kontrol edin.';
        if (err.type === 'peer-unavailable') {
          msg = `"${this.roomCode}" kodlu oda bulunamadı! Oda sahibinin odayı kurduğundan emin olun.`;
        }
        if (window.showInGameAlert) {
          window.showInGameAlert(msg, 'warning', '⚠️ ODA BULUNAMADI');
        }
        if (this.onError) this.onError(err);
        reject(err);
      });
    });
  }

  // Host'tan Client'a gelen mesajları işle
  handleHostMessage(data) {
    if (!data || !data.type) return;

    if (data.type === 'LOBBY_STATE') {
      // Host'tan gelen güncel lobi oyuncu listesi
      if (this.onLobbyUpdated) {
        this.onLobbyUpdated(data.players || [], data.roomCode);
      }
    } else if (data.type === 'GAME_START') {
      // Host oyunu başlattı!
      this.game.worldWidth = data.worldWidth || 3200;
      this.game.worldHeight = data.worldHeight || 3200;

      if (data.foods) {
        this.game.foods = data.foods.map(f => {
          const foodDef = (typeof FOOD_TYPES !== 'undefined' && FOOD_TYPES.find(ft => ft.type === f.type)) || FOOD_TYPES[0];
          return { x: f.x, y: f.y, ...foodDef, pulse: Math.random() * Math.PI * 2 };
        });
      }

      // Kendi başlangıç noktamı bul
      let mySp = null;
      if (data.spawns && data.spawns[this.myPeerId]) {
        mySp = data.spawns[this.myPeerId];
      } else if (data.mySpawn) {
        mySp = data.mySpawn;
      }

      // Diğer oyuncuları remotePlayers içine ekle
      this.remotePlayers.clear();
      const playersList = data.players || [];
      playersList.forEach(p => {
        const pId = p.id || p.peerId;
        if (pId !== this.myPeerId) {
          const skin = (typeof SKINS !== 'undefined' && SKINS.find(s => s.id === p.skinId)) || SKINS[0];
          const sp = (data.spawns && data.spawns[pId]) || { x: this.game.worldWidth / 2, y: this.game.worldHeight / 2, angle: 0 };
          const worm = new Worm(sp.x, sp.y, p.name, skin, !!p.isBot);
          worm.peerId = pId;
          worm.hat = p.hatId || 'none';
          worm.angle = sp.angle || 0;
          this.remotePlayers.set(pId, worm);
        }
      });

      // İstemci oyununu başlat
      this.game.startMultiplayerClientGame(mySp);
    } else if (data.type === 'RESPAWN_ACK') {
      // Tekrar canlanma onayı
      if (this.game.player) {
        this.game.player.x = data.x;
        this.game.player.y = data.y;
        this.game.player.isDead = false;
        this.game.player.body = [{ x: data.x, y: data.y }, { x: data.x - 10, y: data.y }];
        this.game.player.score = 10;
        this.game.gameOverScreen.classList.add('hidden');
        if (this.game.joystickZone) this.game.joystickZone.classList.remove('hidden');
        this.game.state = 'PLAYING';
      }
    } else if (data.type === 'GAME_TICK') {
      // Host'tan gelen anlık fizik karesi
      const activeIds = new Set();

      data.worms.forEach(wData => {
        activeIds.add(wData.peerId);

        if (wData.peerId === this.myPeerId) {
          // KENDİ SOLUCANIMIN KONUM, SKOR VE ÖLÜM DURUMUNU EŞİTLE
          if (wData.isDead && !this.game.player.isDead) {
            this.game.handlePlayerDeath(wData.killedBy || 'Başka bir solucan');
          }
          this.game.player.score = wData.score;
          this.game.player.kills = wData.kills || 0;
          this.game.player.radius = wData.radius;

          // Yumuşak İstemci Uzlaşması (Smooth Client Reconciliation)
          // Eğer sunucu konumu ile yerel tahmin arasında büyük bir fark varsa düzelt
          const dx = wData.x - this.game.player.x;
          const dy = wData.y - this.game.player.y;
          const distSq = dx * dx + dy * dy;

          if (distSq > 10000) {
            // Ciddi kayma veya respawn: doğrudan eşitle
            this.game.player.x = wData.x;
            this.game.player.y = wData.y;
            this.game.player.angle = wData.angle;
            if (wData.body && wData.body.length > 0) {
              this.game.player.body = wData.body;
            }
          } else if (distSq > 25) {
            // Küçük ağ gecikmesi: kademeli olarak kaydır
            this.game.player.x += dx * 0.25;
            this.game.player.y += dy * 0.25;
          }
        } else {
          // UZAKTAKİ ARKADAŞ VEYA BOT
          let worm = this.remotePlayers.get(wData.peerId);
          if (!worm) {
            const skin = (typeof SKINS !== 'undefined' && SKINS.find(s => s.id === wData.skinId)) || SKINS[0];
            worm = new Worm(wData.x, wData.y, wData.name, skin, !!wData.isBot);
            worm.peerId = wData.peerId;
            worm.hat = wData.hatId || 'none';
            this.remotePlayers.set(wData.peerId, worm);
          }
          worm.targetAngle = wData.angle;
          const rdx = wData.x - worm.x;
          const rdy = wData.y - worm.y;
          if (rdx * rdx + rdy * rdy > 6400) {
            worm.x = wData.x;
            worm.y = wData.y;
            worm.angle = wData.angle;
            if (wData.body && wData.body.length > 0) {
              worm.body = wData.body;
            }
          } else {
            worm.x += rdx * 0.35;
            worm.y += rdy * 0.35;
          }
          worm.radius = wData.radius;
          worm.score = wData.score;
          worm.kills = wData.kills || 0;
          worm.isBoosting = !!wData.isBoosting;
          worm.isDead = !!wData.isDead;
          worm.hat = wData.hatId || worm.hat;
        }
      });

      // Artık var olmayan solucanları temizle
      for (const [pId] of this.remotePlayers.entries()) {
        if (!activeIds.has(pId)) {
          this.remotePlayers.delete(pId);
        }
      }

      // Yenen / Yeni çıkan yiyecekleri senkronize et
      if (data.newFoods && data.newFoods.length > 0) {
        data.newFoods.forEach(nf => {
          this.game.spawnFood(nf.x, nf.y, nf.type);
        });
      }
      if (data.eatenIndices && data.eatenIndices.length > 0) {
        data.eatenIndices.sort((a, b) => b - a).forEach(idx => {
          if (this.game.foods[idx]) this.game.foods.splice(idx, 1);
        });
      }
    }
  }

  // ==================== 4. ANLIK DURUM YAYINI (HOST) ====================
  // Host: Tüm bağlı istemcilere anlık oyun durumunu yayınlar (Throttled)
  broadcastState(worms, newFoods = [], eatenIndices = []) {
    if (!this.isHost || this.connections.size === 0) return;

    const payload = {
      type: 'GAME_TICK',
      worms: worms.map(w => ({
        peerId: w.peerId || 'host',
        name: w.name,
        skinId: w.skin ? w.skin.id : 'white_king',
        hatId: w.hat || 'none',
        isBot: !!w.isBot,
        x: Math.round(w.x),
        y: Math.round(w.y),
        angle: Number(w.angle.toFixed(2)),
        radius: Math.round(w.radius),
        score: Math.round(w.score),
        kills: w.kills || 0,
        isBoosting: !!w.isBoosting,
        isDead: !!w.isDead,
        body: w.body.map(seg => ({ x: Math.round(seg.x), y: Math.round(seg.y) }))
      })),
      newFoods: newFoods,
      eatenIndices: eatenIndices
    };

    this.connections.forEach(conn => {
      if (conn && conn.open) {
        try {
          conn.send(payload);
        } catch (e) {
          console.warn('Durum yayını hatası:', e);
        }
      }
    });
  }

  // ==================== 5. OYUNCU GİRDİSİ (CLIENT) ====================
  // Client: Host'a kendi yön ve turbo durumunu kısıtlamalı (throttled) gönderir
  sendThrottledInput(targetAngle, isBoosting) {
    if (this.isHost || !this.hostConn || !this.hostConn.open) return;

    const now = performance.now();
    const angleDiff = Math.abs(targetAngle - this.lastSentAngle);
    const boostChanged = isBoosting !== this.lastSentBoosting;

    // Açı farkı > 0.02 rad veya turbo değiştiyse veya 40ms geçtiyse gönder (~25 input/sn)
    if (boostChanged || angleDiff > 0.02 || (now - this.lastInputTime > 40)) {
      this.lastSentAngle = targetAngle;
      this.lastSentBoosting = isBoosting;
      this.lastInputTime = now;

      try {
        this.hostConn.send({
          type: 'PLAYER_INPUT',
          targetAngle: Number(targetAngle.toFixed(2)),
          isBoosting: isBoosting
        });
      } catch (e) {
        console.warn('Input gönderme hatası:', e);
      }
    }
  }

  // Client: Host'a yeniden canlanma isteği gönderir
  requestRespawn() {
    if (this.isHost || !this.hostConn || !this.hostConn.open) return;
    try {
      this.hostConn.send({ type: 'PLAYER_RESPAWN' });
    } catch (e) {
      console.warn('Respawn isteği hatası:', e);
    }
  }

  removeRemotePlayer(peerId) {
    const worm = this.remotePlayers.get(peerId);
    if (worm) {
      worm.isDead = true;
      this.remotePlayers.delete(peerId);
    }
  }

  // Odadan ayrıl / bağlantıyı temizle
  disconnect() {
    if (this.isHost && this.connections.size > 0) {
      this.broadcast({ type: 'HOST_CLOSED' });
    }
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch (e) {}
      this.peer = null;
    }
    this.connections.clear();
    this.lobbyPlayers.clear();
    this.remotePlayers.clear();
    this.hostConn = null;
    this.isMultiplayer = false;
    this.isHost = false;
    this.roomCode = null;
    this.myPeerId = null;
  }
}
