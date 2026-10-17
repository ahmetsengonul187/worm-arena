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
  // NOT: Emülatör + aynı bilgisayardaki tarayıcı veya katı NAT arkasındaki cihazlar
  // doğrudan (STUN) bağlanamaz; bu durumda TURN röle sunucusu ŞARTTIR.
  getIceServers() {
    return [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
      {
        // Open Relay Project (ücretsiz genel TURN rölesi)
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        // FreeSTUN (ücretsiz genel TURN rölesi - yedek)
        urls: ['turn:freestun.net:3478', 'turns:freestun.net:5350'],
        username: 'free',
        credential: 'free'
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

  // Bağlantının açık ve veri aktarmaya hazır olduğunu doğrula
  isConnReady(conn) {
    if (!conn) return false;
    if (conn.open) return true;
    if (conn.dataChannel && conn.dataChannel.readyState === 'open') {
      conn._open = true;
      return true;
    }
    return false;
  }

  // Gelen arkadaş bağlantısını karşıla (Host tarafı)
  handleIncomingConnection(conn) {
    const markConnected = () => {
      this.connections.set(conn.peer, conn);
      if (conn.dataChannel && conn.dataChannel.readyState === 'open') {
        conn._open = true;
      }
      console.log('Arkadaş bağlandı:', conn.peer);
      // Bağlanan istemciye anında güncel lobi durumunu yay
      if (this.game.state !== 'PLAYING') {
        this.broadcastLobbyState();
      }
    };

    // Bağlantıyı HEMEN kaydet - hazır olmasını bekleme!
    this.connections.set(conn.peer, conn);

    if (this.isConnReady(conn)) {
      markConnected();
    } else {
      conn.on('open', markConnected);
      if (conn.dataChannel) {
        if (conn.dataChannel.readyState === 'open') {
          markConnected();
        } else {
          conn.dataChannel.addEventListener('open', markConnected, { once: true });
        }
      }
    }

    conn.on('data', (data) => {
      // Veri akışı varsa kanal kesinlikle açıktır!
      this.connections.set(conn.peer, conn);
      if (conn.dataChannel && conn.dataChannel.readyState === 'open') {
        conn._open = true;
      }
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
      if (this.isConnReady(conn)) {
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

      // Odaya katılan oyuncuyu lobiye ekle ve güncel oyuncu listesini herkese yay
      // EĞER OYUN HALİHAZIRDA OYNANIYORSA, YENİ GELEN OYUNCUYU DERHAL ARENAYA SOK!
      if (this.game.state === 'PLAYING') {
        const skin = (typeof SKINS !== 'undefined' && SKINS.find(s => s.id === pInfo.skinId)) || SKINS[0];
        const rx = Math.round(this.game.worldWidth / 2 + (Math.random() - 0.5) * 800);
        const ry = Math.round(this.game.worldHeight / 2 + (Math.random() - 0.5) * 800);
        const worm = new Worm(rx, ry, pInfo.name, skin, false);
        worm.peerId = peerId;
        worm.hat = pInfo.hatId || 'none';
        worm.ghostTimer = 150;
        this.remotePlayers.set(peerId, worm);

        const conn = this.connections.get(peerId);
        if (this.isConnReady(conn)) {
          conn.send({
            type: 'GAME_START',
            roomCode: this.roomCode,
            worldWidth: this.game.worldWidth,
            worldHeight: this.game.worldHeight,
            foodSeed: Number(this.roomCode) || 12345,
            spawns: { [peerId]: { x: rx, y: ry, angle: 0 } },
            players: this.getLobbyList()
          });
        }
      } else {
        this.broadcastLobbyState();
      }
    } else if (data.type === 'PLAYER_INPUT') {
      const worm = this.remotePlayers.get(peerId);
      if (worm && !worm.isDead) {
        if (typeof data.x === 'number' && typeof data.y === 'number') {
          const dx = data.x - worm.x;
          const dy = data.y - worm.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > 360000) {
            worm.x = data.x;
            worm.y = data.y;
          } else {
            worm.x += dx * 0.45;
            worm.y += dy * 0.45;
          }
        }
        if (typeof data.angle === 'number') {
          worm.angle = data.angle;
        }
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
        if (this.isConnReady(conn)) {
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

    // Host dünyasında tohum tabanlı yiyecekleri tazele (Ağdan 80KB veri aktarmak yerine tohum kodu kullanılır)
    const foodSeed = Number(this.roomCode) || Math.floor(Math.random() * 90000) + 10000;
    if (this.game.initFoodsWithSeed) {
      this.game.initFoodsWithSeed(foodSeed, 800);
    } else {
      this.game.initFoods(800);
    }

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
      worm.ghostTimer = 150; // Başlangıç koruması: ilk 2.5 saniye hasarsızlık
      this.remotePlayers.set(peerId, worm);
    });

    // Host'un kendi solucanını başlat
    const hostSp = spawns['host'] || { x: centerX, y: centerY, angle: 0 };
    this.game.startMultiplayerHostGame(includeBots, hostSp.x, hostSp.y, hostSp.angle);

    // Tüm bağlı istemcilere HAFİF ve KESİNTİSİZ GAME_START paketi yayınla (~300 bayt)
    const payload = {
      type: 'GAME_START',
      roomCode: this.roomCode,
      worldWidth: this.game.worldWidth,
      worldHeight: this.game.worldHeight,
      foodSeed: foodSeed,
      spawns: spawns,
      players: list
    };

    // İlk paket hemen gönderilir
    this.broadcast(payload);

    // WebRTC paket kaybına karşı 120ms ve 280ms sonra teyit paketleri gönderilir
    setTimeout(() => {
      if (this.isHost && this.game.state === 'PLAYING') {
        this.broadcast(payload);
      }
    }, 120);
    setTimeout(() => {
      if (this.isHost && this.game.state === 'PLAYING') {
        this.broadcast(payload);
      }
    }, 280);
  }

  // ==================== 3. ODAYA KATIL (CLIENT OL) ====================
  // Bağlantı kurulamazsa otomatik olarak 3 kez yeniden dener (TURN rölesi bazen geç cevap verir)
  joinRoom(code, attempt = 1) {
    const MAX_ATTEMPTS = 3;
    const ATTEMPT_TIMEOUT_MS = 20000;

    return new Promise((resolve, reject) => {
      this.disconnect();

      // Her deneme için benzersiz oturum: eski denemelerden gelen geç olayları yok say
      const session = (this.joinSession = (this.joinSession || 0) + 1);
      const isStale = () => session !== this.joinSession;
      let settled = false;

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

      if (this.onJoinStatus) {
        this.onJoinStatus(attempt === 1
          ? 'Oda sahibine bağlanılıyor...'
          : `Bağlantı yeniden deneniyor (${attempt}/${MAX_ATTEMPTS})...`);
      }

      // Başarısız denemede: hak varsa yeniden dene, yoksa hata ver
      const failAttempt = (reason, userMsg, title) => {
        if (settled || isStale()) return;
        settled = true;
        clearTimeout(connTimeout);
        console.warn(`Katılma denemesi ${attempt} başarısız:`, reason);

        if (attempt < MAX_ATTEMPTS) {
          setTimeout(() => {
            if (isStale()) return;
            this.joinRoom(code, attempt + 1).then(resolve).catch(reject);
          }, 1200);
          return;
        }

        if (window.showInGameAlert) {
          window.showInGameAlert(userMsg, 'warning', title);
        }
        this.disconnect();
        if (this.onError) this.onError(reason);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      };

      this.peer = new Peer({
        debug: 1,
        config: {
          iceServers: this.getIceServers(),
          sdpSemantics: 'unified-plan',
          iceCandidatePoolSize: 4
        }
      });

      const connTimeout = setTimeout(() => {
        if (!this.hostConn || !this.hostConn.open) {
          failAttempt(
            new Error('Bağlantı zaman aşımı'),
            'Oda sahibine ulaşılamadı. Oda sahibinin uygulamasının açık ve odanın kurulu olduğundan emin olup tekrar deneyin.',
            '⚠️ BAĞLANTI ZAMAN AŞIMI'
          );
        }
      }, ATTEMPT_TIMEOUT_MS);

      this.peer.on('open', (id) => {
        if (isStale()) return;
        this.myPeerId = id;
        console.log('İstemci Peer oluşturuldu:', id);

        // Güvenilir veri kanalı ile host'a bağlan
        const conn = this.peer.connect(targetHostId, { reliable: true });

        const setupClientConn = () => {
          if (isStale() || settled) return;
          settled = true;
          clearTimeout(connTimeout);
          this.hostConn = conn;
          if (conn.dataChannel && conn.dataChannel.readyState === 'open') {
            conn._open = true;
          }
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
        };

        if (this.isConnReady(conn)) {
          setupClientConn();
        } else {
          conn.on('open', setupClientConn);
          if (conn.dataChannel) {
            if (conn.dataChannel.readyState === 'open') {
              setupClientConn();
            } else {
              conn.dataChannel.addEventListener('open', setupClientConn, { once: true });
            }
          }
        }

        conn.on('data', (data) => {
          if (isStale()) return;
          if (conn.dataChannel && conn.dataChannel.readyState === 'open') {
            conn._open = true;
          }
          this.handleHostMessage(data);
        });

        conn.on('close', () => {
          if (isStale() || this.hostConn !== conn) return;
          console.warn('Oda sahibi ile bağlantı kesildi');
          if (window.showInGameAlert) {
            window.showInGameAlert('Oda bağlantısı kesildi. Menüye dönülüyor...', 'warning', '⚠️ BAĞLANTI KOPTU');
          }
          // Hemen oyundan atmak yerine 3 sn bekle
          setTimeout(() => {
            if (this.game && this.game.state === 'PLAYING') {
              this.game.returnToMenu();
            }
          }, 3000);
        });

        conn.on('error', (err) => {
          failAttempt(err, 'Oda sahibine bağlanırken hata oluştu. Lütfen tekrar deneyin.', '⚠️ BAĞLANTI HATASI');
        });
      });

      this.peer.on('error', (err) => {
        console.error('Odaya bağlanılamadı:', err);
        let msg = 'Odaya bağlanılamadı. İnternet bağlantınızı kontrol edin.';
        let title = '⚠️ BAĞLANTI HATASI';
        if (err && err.type === 'peer-unavailable') {
          msg = `"${this.roomCode}" kodlu oda bulunamadı! Oda sahibinin odayı kurduğundan ve uygulamanın açık olduğundan emin olun.`;
          title = '⚠️ ODA BULUNAMADI';
        }
        failAttempt(err, msg, title);
      });
    });
  }

  // Host'tan Client'a gelen mesajları işle
  handleHostMessage(data) {
    if (!data || !data.type) return;

    if (data.type === 'LOBBY_STATE') {
      // Host'tan gelen güncel lobi oyuncu listesi (oyun oynanıyorsa lobiyi tekrar açma)
      if (this.game.state !== 'PLAYING') {
        if (this.onLobbyUpdated) {
          this.onLobbyUpdated(data.players || [], data.roomCode);
        }
      }
    } else if (data.type === 'GAME_START') {
      if (this.game.state === 'PLAYING') {
        return; // Zaten arenadayız, mükerrer teyit paketlerini yoksay
      }

      console.log('GAME_START paketi alındı! Arenaya giriliyor...');
      this.game.worldWidth = data.worldWidth || 6400;
      this.game.worldHeight = data.worldHeight || 6400;

      // Bekleme odasını ve çok oyunculu modalı hemen kapat
      const multiplayerModal = document.getElementById('multiplayerModal');
      if (multiplayerModal) {
        multiplayerModal.classList.add('hidden');
        multiplayerModal.style.display = 'none';
      }
      const waitingRoomTabContent = document.getElementById('waitingRoomTabContent');
      if (waitingRoomTabContent) waitingRoomTabContent.classList.add('hidden');
      const joinRoomTabContent = document.getElementById('joinRoomTabContent');
      if (joinRoomTabContent) joinRoomTabContent.classList.add('hidden');
      const createRoomTabContent = document.getElementById('createRoomTabContent');
      if (createRoomTabContent) createRoomTabContent.classList.add('hidden');

      if (this.game.startScreen) {
        this.game.startScreen.classList.add('hidden');
        this.game.startScreen.style.display = 'none';
      }

      // Tohum tabanlı yiyecekleri başlat
      if (data.foodSeed && this.game.initFoodsWithSeed) {
        this.game.initFoodsWithSeed(data.foodSeed, 800);
      } else if (data.foods) {
        this.game.foods = data.foods.map(f => {
          const foodDef = (typeof FOOD_TYPES !== 'undefined' && FOOD_TYPES.find(ft => ft.type === f.type)) || FOOD_TYPES[0];
          return { x: f.x, y: f.y, ...foodDef, pulse: Math.random() * Math.PI * 2 };
        });
      } else {
        this.game.initFoods(800);
      }

      // Kendi başlangıç noktamı bul (akıllı eşleme garantisi)
      let mySp = null;
      if (data.spawns) {
        if (this.myPeerId && data.spawns[this.myPeerId]) {
          mySp = data.spawns[this.myPeerId];
        } else {
          const nonHostKey = Object.keys(data.spawns).find(k => k !== 'host');
          if (nonHostKey) mySp = data.spawns[nonHostKey];
        }
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
          worm.ghostTimer = 150; // Başlangıç koruması
          this.remotePlayers.set(pId, worm);
        }
      });

      // İstemci oyununu başlat
      if (this.game.state !== 'PLAYING') {
        this.game.startMultiplayerClientGame(mySp);
      }
    } else if (data.type === 'RESPAWN_ACK') {
      // Tekrar canlanma onayı
      if (this.game.player) {
        this.game.player.x = data.x;
        this.game.player.y = data.y;
        this.game.player.isDead = false;
        this.game.player.ghostTimer = 150;
        this.game.player.body = [{ x: data.x, y: data.y }, { x: data.x - 10, y: data.y }];
        this.game.player.score = 30;
        this.game.gameOverScreen.classList.add('hidden');
        if (this.game.joystickZone) this.game.joystickZone.classList.remove('hidden');
        this.game.state = 'PLAYING';
      }
    } else if (data.type === 'GAME_TICK') {
      // Host'tan gelen anlık fizik karesi
      // EĞER OYUN HENÜZ BAŞLATILMAMIŞSA (GAME_START paketi kaçtıysa), İSTEMCİYİ DERHAL ARENAYA SOK!
      if (this.game.state !== 'PLAYING') {
        console.log('GAME_TICK alındı, oyun lobi durumundaydı - Arenaya zorla sokuluyor!');
        const myWormData = data.worms ? (data.worms.find(w => w.peerId === this.myPeerId) || data.worms.find(w => w.peerId !== 'host' && !w.isBot)) : null;
        const mySp = myWormData ? { x: myWormData.x, y: myWormData.y, angle: myWormData.angle } : null;
        this.game.startMultiplayerClientGame(mySp);
      }

      if (!this.game.player) return;

      const activeIds = new Set();
      data.worms.forEach(wData => {
        activeIds.add(wData.peerId);

        if (wData.peerId === this.myPeerId) {
          // KENDİ SOLUCANIMIZ:
          // Ölüm durumunu senkronize et
          if (wData.isDead && this.game.player && !this.game.player.isDead) {
            this.game.handlePlayerDeath(wData.killedBy || 'Başka bir solucan');
          }
          if (this.game.player) {
            // Skor, leş ve kütleyi eşitle (Yerel kontrolümüz asla geriye çekilmez, böylece yılan ASLA mekik dokumaz!)
            if (typeof wData.score === 'number' && wData.score > this.game.player.score) {
              this.game.player.score = wData.score;
            }
            if (typeof wData.kills === 'number') {
              this.game.player.kills = Math.max(this.game.player.kills || 0, wData.kills);
            }
            if (typeof wData.radius === 'number') {
              this.game.player.radius = wData.radius;
            }
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
          worm.angle = wData.angle;
          const rdx = wData.x - worm.x;
          const rdy = wData.y - worm.y;
          if (rdx * rdx + rdy * rdy > 250000) {
            worm.x = wData.x;
            worm.y = wData.y;
          } else {
            worm.x += rdx * 0.35;
            worm.y += rdy * 0.35;
          }
          if (wData.body && wData.body.length > 0) {
            worm.body = wData.body;
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
  // Host: Tüm bağlı istemcilere anlık oyun durumunu yayınlar (Throttled & Downsampled)
  broadcastState(worms, newFoods = [], eatenIndices = []) {
    if (!this.isHost || this.connections.size === 0) return;

    // Gövde segmentlerini ağ üzerinden aktarırken seyrelt (downsample):
    // Her karede 50 segment yerine ana omurgayı (18-22 segment) aktararak bant genişliğini %70 düşürür
    const payload = {
      type: 'GAME_TICK',
      worms: worms.map((w, idx) => {
        const step = Math.max(1, Math.ceil(w.body.length / 22));
        const downsampledBody = [];
        for (let b = 0; b < w.body.length; b += step) {
          downsampledBody.push({ x: Math.round(w.body[b].x), y: Math.round(w.body[b].y) });
        }
        if (w.body.length > 0 && (w.body.length - 1) % step !== 0) {
          const tail = w.body[w.body.length - 1];
          downsampledBody.push({ x: Math.round(tail.x), y: Math.round(tail.y) });
        }

        const fallbackPeerId = (w === this.game.player) ? 'host' : (w.isBot ? ('bot_' + idx) : ('player_' + idx));
        const wormPeerId = w.peerId || fallbackPeerId;

        return {
          peerId: wormPeerId,
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
          body: downsampledBody
        };
      }),
      newFoods: newFoods,
      eatenIndices: eatenIndices
    };

    this.connections.forEach(conn => {
      if (this.isConnReady(conn)) {
        // RTCDataChannel Buffer Taşması Kontrolü (Buffer > 32KB ise bu kareyi atla, kanalı çökertme!)
        if (conn.dataChannel && conn.dataChannel.bufferedAmount > 32768) {
          return;
        }
        try {
          conn.send(payload);
        } catch (e) {
          console.warn('Durum yayını hatası:', e);
        }
      }
    });
  }

  // ==================== 5. OYUNCU GİRDİSİ (CLIENT) ====================
  // Client: Host'a kendi yön, turbo ve anlık koordinat durumunu kısıtlamalı (throttled) gönderir
  sendThrottledInput(targetAngle, isBoosting, posX = null, posY = null, currentAngle = null) {
    if (this.isHost || !this.isConnReady(this.hostConn)) return;

    const now = performance.now();
    const angleDiff = Math.abs(targetAngle - this.lastSentAngle);
    const boostChanged = isBoosting !== this.lastSentBoosting;

    // Açı farkı > 0.015 rad veya turbo değiştiyse veya 35ms geçtiyse gönder (~28 input/sn)
    if (boostChanged || angleDiff > 0.015 || (now - this.lastInputTime > 35)) {
      this.lastSentAngle = targetAngle;
      this.lastSentBoosting = isBoosting;
      this.lastInputTime = now;

      const payload = {
        type: 'PLAYER_INPUT',
        targetAngle: Number(targetAngle.toFixed(2)),
        isBoosting: !!isBoosting
      };

      if (posX !== null && posY !== null) {
        payload.x = Math.round(posX);
        payload.y = Math.round(posY);
      }
      if (currentAngle !== null) {
        payload.angle = Number(currentAngle.toFixed(2));
      }

      try {
        this.hostConn.send(payload);
      } catch (e) {
        console.warn('Input gönderme hatası:', e);
      }
    }
  }

  // Client: Host'a yeniden canlanma isteği gönderir
  requestRespawn() {
    if (this.isHost || !this.isConnReady(this.hostConn)) return;
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
