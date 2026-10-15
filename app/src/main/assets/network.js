/* ========================================================
   WORM ARENA - ÇOK OYUNCULU AĞ MOTORU (WebRTC / PeerJS)
   Sunucu kurmaya gerek kalmadan internet veya Wi-Fi üzerinden
   arkadaşların aynı odaya katılarak oynamasını sağlar.
   ======================================================== */

class NetworkManager {
  constructor(game) {
    this.game = game;
    this.peer = null;
    this.isHost = false;
    this.isMultiplayer = false;
    this.roomCode = null;
    this.connections = new Map(); // Host için: peerId -> DataConnection
    this.hostConn = null; // Client için: host DataConnection
    this.remotePlayers = new Map(); // peerId -> Worm nesnesi
    this.myPeerId = null;

    this.onPlayerJoined = null;
    this.onPlayerLeft = null;
    this.onRoomReady = null;
    this.onError = null;
  }

  // Rastgele 4 haneli kolay oda kodu üret (örn: 7842)
  generateRoomCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  // 1. ODA KUR (HOST OL)
  createRoom(customCode = null) {
    return new Promise((resolve, reject) => {
      this.isHost = true;
      this.isMultiplayer = true;
      this.roomCode = customCode || this.generateRoomCode();
      const peerId = `wormarena-${this.roomCode}`;

      if (typeof Peer === 'undefined') {
        if (window.showInGameAlert) {
          window.showInGameAlert('Çok oyunculu ağ kütüphanesi yüklenemedi. Lütfen internet bağlantınızı kontrol edin.', 'warning', '⚠️ BAĞLANTI HATASI');
        }
        reject(new Error('PeerJS not loaded'));
        return;
      }

      this.peer = new Peer(peerId, {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });

      this.peer.on('open', (id) => {
        this.myPeerId = id;
        console.log('Oda kuruldu! Kod:', this.roomCode);
        if (this.onRoomReady) this.onRoomReady(this.roomCode);
        resolve(this.roomCode);
      });

      this.peer.on('connection', (conn) => {
        this.handleIncomingConnection(conn);
      });

      this.peer.on('error', (err) => {
        console.error('Peer error:', err);
        if (err.type === 'unavailable-id') {
          // Kod doluysa yenisini dene
          this.createRoom(this.generateRoomCode()).then(resolve).catch(reject);
        } else {
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

      // Bağlanan arkadaşa mevcut dünya durumunu ve yiyecekleri gönder
      conn.send({
        type: 'INIT_WORLD',
        foods: this.game.foods.map(f => ({ x: Math.round(f.x), y: Math.round(f.y), type: f.type })),
        worldWidth: this.game.worldWidth,
        worldHeight: this.game.worldHeight
      });
    });

    conn.on('data', (data) => {
      this.handleClientMessage(conn.peer, data);
    });

    conn.on('close', () => {
      this.removeRemotePlayer(conn.peer);
      this.connections.delete(conn.peer);
      if (this.onPlayerLeft) this.onPlayerLeft(conn.peer);
    });
  }

  // 2. ODAYA KATIL (CLIENT OL)
  joinRoom(code) {
    return new Promise((resolve, reject) => {
      this.isHost = false;
      this.isMultiplayer = true;
      this.roomCode = code.trim();
      const targetHostId = `wormarena-${this.roomCode}`;

      if (typeof Peer === 'undefined') {
        if (window.showInGameAlert) {
          window.showInGameAlert('Çok oyunculu ağ kütüphanesi yüklenemedi. Lütfen internet bağlantınızı kontrol edin.', 'warning', '⚠️ BAĞLANTI HATASI');
        }
        reject(new Error('PeerJS not loaded'));
        return;
      }

      this.peer = new Peer({
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });

      this.peer.on('open', (id) => {
        this.myPeerId = id;
        const conn = this.peer.connect(targetHostId, { reliable: false });

        conn.on('open', () => {
          this.hostConn = conn;
          console.log('Odaya bağlanıldı!');
          if (window.showInGameAlert) {
            window.showInGameAlert(`Odaya başarıyla bağlandın! İyi oyunlar.`, 'success', '🎮 BAĞLANDI');
          }

          // Host'a kendi profil bilgilerini gönder
          conn.send({
            type: 'PLAYER_HELLO',
            name: this.game.player.name,
            skinId: this.game.player.skin.id
          });

          resolve(this.roomCode);
        });

        conn.on('data', (data) => {
          this.handleHostMessage(data);
        });

        conn.on('close', () => {
          if (window.showInGameAlert) {
            window.showInGameAlert('Oda sahibi oyunu kapattı veya bağlantı koptu.', 'warning', '⚠️ BAĞLANTI KOPTU');
          }
          this.game.returnToMenu();
        });

        conn.on('error', (err) => {
          console.error('Bağlantı hatası:', err);
          reject(err);
        });
      });

      this.peer.on('error', (err) => {
        console.error('Odaya bağlanılamadı:', err);
        if (this.onError) this.onError(err);
        reject(err);
      });
    });
  }

  // Client'tan Host'a gelen mesajlar
  handleClientMessage(peerId, data) {
    if (data.type === 'PLAYER_HELLO') {
      const skin = SKINS.find(s => s.id === data.skinId) || SKINS[0];
      const newWorm = new Worm(
        this.game.worldWidth / 2 + (Math.random() - 0.5) * 400,
        this.game.worldHeight / 2 + (Math.random() - 0.5) * 400,
        data.name || 'Misafir',
        skin,
        false
      );
      newWorm.peerId = peerId;
      this.remotePlayers.set(peerId, newWorm);

      if (this.onPlayerJoined) {
        this.onPlayerJoined({ id: peerId, name: data.name });
      }
    } else if (data.type === 'PLAYER_INPUT') {
      const worm = this.remotePlayers.get(peerId);
      if (worm && !worm.isDead) {
        worm.targetAngle = data.targetAngle;
        worm.isBoosting = data.isBoosting;
      }
    }
  }

  // Host'tan Client'a gelen mesajlar
  handleHostMessage(data) {
    if (data.type === 'INIT_WORLD') {
      // Dünyayı senkronize et
      this.game.worldWidth = data.worldWidth;
      this.game.worldHeight = data.worldHeight;
      this.game.foods = data.foods.map(f => {
        const foodDef = FOOD_TYPES.find(ft => ft.type === f.type) || FOOD_TYPES[0];
        return { x: f.x, y: f.y, ...foodDef, pulse: Math.random() * Math.PI * 2 };
      });
      this.game.startMultiplayerClientGame();
    } else if (data.type === 'GAME_TICK') {
      // Diğer tüm solucanların konumlarını güncelle
      data.worms.forEach(wData => {
        if (wData.peerId === this.myPeerId) {
          // Kendi onaylanmış skor ve ölüm durumum
          if (wData.isDead && !this.game.player.isDead) {
            this.game.handlePlayerDeath(wData.killedBy || 'Başka bir solucan');
          }
          this.game.player.score = wData.score;
          this.game.player.kills = wData.kills;
        } else {
          // Uzaktaki arkadaş veya bot solucanı
          let worm = this.remotePlayers.get(wData.peerId);
          if (!worm) {
            const skin = SKINS.find(s => s.id === wData.skinId) || SKINS[0];
            worm = new Worm(wData.x, wData.y, wData.name, skin, wData.isBot);
            worm.peerId = wData.peerId;
            this.remotePlayers.set(wData.peerId, worm);
          }
          worm.x = wData.x;
          worm.y = wData.y;
          worm.angle = wData.angle;
          worm.radius = wData.radius;
          worm.score = wData.score;
          worm.kills = wData.kills;
          worm.isBoosting = wData.isBoosting;
          worm.isDead = wData.isDead;
          worm.body = wData.body;
        }
      });

      // Yenen / Yeni çıkan yiyecekleri senkronize et
      if (data.newFoods) {
        data.newFoods.forEach(nf => {
          this.game.spawnFood(nf.x, nf.y, nf.type);
        });
      }
      if (data.eatenIndices) {
        data.eatenIndices.sort((a, b) => b - a).forEach(idx => {
          if (this.game.foods[idx]) this.game.foods.splice(idx, 1);
        });
      }
    }
  }

  // Host: Tüm istemcilere anlık oyun durumunu yayınla (25 FPS Broadcast)
  broadcastState(worms, newFoods = [], eatenIndices = []) {
    if (!this.isHost || this.connections.size === 0) return;

    const payload = {
      type: 'GAME_TICK',
      worms: worms.map(w => ({
        peerId: w.peerId || 'host',
        name: w.name,
        skinId: w.skin.id,
        isBot: w.isBot,
        x: Math.round(w.x),
        y: Math.round(w.y),
        angle: Number(w.angle.toFixed(2)),
        radius: Math.round(w.radius),
        score: Math.round(w.score),
        kills: w.kills,
        isBoosting: w.isBoosting,
        isDead: w.isDead,
        body: w.body.map(seg => ({ x: Math.round(seg.x), y: Math.round(seg.y) }))
      })),
      newFoods: newFoods,
      eatenIndices: eatenIndices
    };

    this.connections.forEach(conn => {
      if (conn.open) {
        conn.send(payload);
      }
    });
  }

  // Client: Host'a kendi yön ve turbo durumunu gönder
  sendPlayerInput(targetAngle, isBoosting) {
    if (this.isHost || !this.hostConn || !this.hostConn.open) return;

    this.hostConn.send({
      type: 'PLAYER_INPUT',
      targetAngle: Number(targetAngle.toFixed(2)),
      isBoosting: isBoosting
    });
  }

  removeRemotePlayer(peerId) {
    const worm = this.remotePlayers.get(peerId);
    if (worm) {
      worm.isDead = true;
      this.remotePlayers.delete(peerId);
    }
  }

  disconnect() {
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    this.connections.clear();
    this.remotePlayers.clear();
    this.isMultiplayer = false;
    this.isHost = false;
    this.roomCode = null;
  }
}
