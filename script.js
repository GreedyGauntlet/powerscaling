import {initializeApp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDocs, getDoc, setDoc, addDoc, increment,
  serverTimestamp, runTransaction, query, orderBy, limit, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyClBqIIbvpCqzFow35AYKhNTdLEAJ78mRU",
  authDomain: "walldatabase.firebaseapp.com",
  projectId: "walldatabase",
  storageBucket: "walldatabase.firebasestorage.app",
  messagingSenderId: "1030865166080",
  appId: "1:1030865166080:web:c93f7e1c6ffb20a05d9de5"
};

const fb = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fb), db = getFirestore(fb);

const $ = s => document.querySelector(s);
const app = $('#app'), detail = $('#detail');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));
const rand = a => a.length ? a[Math.floor(Math.random() * a.length)] : null;
const pairId = (a, b) => [a, b].sort().join('_');

let user = null;
let things = [];
let duel = null;
let userVotes = new Set();
let profileThingId = null;
let chatUnsub = null;
let pickedFile = null; // kept for compatibility with the original project

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.style.display = 'none', 3200);
}

/* ---------- data ---------- */
async function loadThings() {
  const snap = await getDocs(collection(db, 'things'));
  things = snap.docs.map(d => ({id: d.id, ...d.data()}));
}

async function loadPairs() {
  const snap = await getDocs(collection(db, 'pairs'));
  return snap.docs.map(d => ({id: d.id, ...d.data()}));
}

/*
 * Each user's vote is stored independently from the aggregate pair result.
 * The transaction makes the "one vote per pair per user" check atomic.
 */
async function loadUserVotes() {
  userVotes.clear();
  if (!user) return;

  const snap = await getDocs(collection(db, 'users', user.uid, 'votes'));
  snap.forEach(d => userVotes.add(d.id));
}

async function loadProfile() {
  profileThingId = null;
  if (!user) return;
  const snap = await getDoc(doc(db, 'users', user.uid));
  if (snap.exists()) profileThingId = snap.data().profileThingId || null;
}

async function recordResult(winner, loser) {
  if (!user) throw new Error('You must be signed in to vote.');

  const a = winner.id < loser.id ? winner.id : loser.id;
  const b = winner.id < loser.id ? loser.id : winner.id;
  const id = pairId(a, b);
  const voteRef = doc(db, 'users', user.uid, 'votes', id);
  const pairRef = doc(db, 'pairs', id);

  await runTransaction(db, async tx => {
    const voteSnap = await tx.get(voteRef);
    if (voteSnap.exists()) throw new Error('You already voted on this matchup.');

    const pairSnap = await tx.get(pairRef);
    const old = pairSnap.exists() ? pairSnap.data() : {};
    const aWon = winner.id === a;

    tx.set(voteRef, {
      uid: user.uid,
      a,
      b,
      winner: winner.id,
      createdAt: serverTimestamp()
    });

    tx.set(pairRef, {
      a,
      b,
      aWins: (old.aWins || 0) + (aWon ? 1 : 0),
      bWins: (old.bWins || 0) + (aWon ? 0 : 1),
      updatedAt: serverTimestamp()
    }, {merge: true});
  });

  userVotes.add(id);
}

/* ---------- Bradley-Terry ---------- */
function bradleyTerry(list, pairs) {
  const n = list.length;
  const idx = new Map(list.map((t, i) => [t.id, i]));
  const W = new Array(n).fill(0.5);
  const games = new Array(n).fill(0);
  const links = [];

  for (const p of pairs) {
    const i = idx.get(p.a), j = idx.get(p.b);
    const aw = p.aWins || 0, bw = p.bWins || 0, m = aw + bw;
    if (i == null || j == null || !m) continue;
    W[i] += aw;
    W[j] += bw;
    games[i] += m;
    games[j] += m;
    links.push([i, j, m]);
  }

  let p = new Array(n).fill(1);
  for (let it = 0; it < 300; it++) {
    const den = p.map(x => 1 / (x + 1));
    for (const [i, j, m] of links) {
      const d = m / (p[i] + p[j]);
      den[i] += d;
      den[j] += d;
    }
    const np = W.map((w, i) => w / den[i]);
    const delta = np.reduce((s, x, i) =>
      Math.max(s, Math.abs(Math.log(x / p[i]))), 0);
    p = np;
    if (delta < 1e-7) break;
  }

  return list.map((t, i) => ({
    ...t,
    rating: 1000 + 400 * Math.log10(p[i]),
    games: games[i]
  })).sort((x, y) => y.rating - x.rating);
}

/*
 * The tier proportions are 1:2:4:8:16:32 from S through F.
 * The cumulative boundaries therefore occur at 1/63, 3/63, 7/63, etc.
 * For a small pool, some tiers naturally contain zero characters.
 */
function tierForRank(rank, total) {
  if (total <= 0) return 'F';
  const q = (rank - 1) / total;
  if (q < 1 / 63) return 'S';
  if (q < 3 / 63) return 'A';
  if (q < 7 / 63) return 'B';
  if (q < 15 / 63) return 'C';
  if (q < 31 / 63) return 'D';
  return 'F';
}

function addTiers(rows) {
  return rows.map((t, i) => ({
    ...t,
    rank: i + 1,
    tier: tierForRank(i + 1, rows.length)
  }));
}

function tierClass(tier) {
  return 'tier-' + String(tier || 'F').toLowerCase();
}

/* ---------- ranking availability ---------- */
function availableOpponents(anchor, extraExcluded = []) {
  const excluded = new Set([anchor.id, ...extraExcluded]);
  return things.filter(t =>
    !excluded.has(t.id) &&
    !userVotes.has(pairId(anchor.id, t.id))
  );
}

function randomAnchor(excludedIds = []) {
  const excluded = new Set(excludedIds);
  const candidates = things.filter(t => !excluded.has(t.id));
  return rand(candidates);
}

function nextRandomizedDuel(excludedAnchors = []) {
  if (things.length < 2) return null;

  const anchors = things.filter(t => !excludedAnchors.includes(t.id));
  for (const anchor of [...anchors].sort(() => Math.random() - 0.5)) {
    const opponent = rand(availableOpponents(anchor));
    if (opponent) return {anchor, a: anchor, b: opponent, count: 0};
  }

  return null;
}

function startDuel(anchor) {
  if (things.length < 2) {
    viewRankMenu();
    return;
  }

  if (anchor) {
    const opponent = rand(availableOpponents(anchor));
    if (!opponent) {
      const next = nextRandomizedDuel([anchor.id]);
      if (!next) {
        viewOutOfRankings();
        return;
      }
      toast(`No new matchups left for ${anchor.name}. Picking another character.`);
      duel = next;
    } else {
      duel = {anchor, a: anchor, b: opponent, count: 0};
    }
  } else {
    const next = nextRandomizedDuel();
    if (!next) {
      viewOutOfRankings();
      return;
    }
    duel = next;
  }

  viewDuel();
}

/* ---------- auth ---------- */
async function submitAuth(e) {
  e.preventDefault();
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const btn = $('#authSubmit');
  const isRegister = btn.dataset.mode === 'register';

  btn.disabled = true;
  btn.dataset.originalText = isRegister ? 'Create account' : 'Sign in';
  btn.textContent = 'Please wait...';

  try {
    if (isRegister) {
      await createUserWithEmailAndPassword(auth, email, password);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (e) {
    const messages = {
      'auth/email-already-in-use': 'An account with that email already exists.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/invalid-credential': 'Incorrect email or password.',
      'auth/user-not-found': 'Incorrect email or password.',
      'auth/wrong-password': 'Incorrect email or password.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/too-many-requests': 'Too many attempts. Please try again later.'
    };
    toast(messages[e.code] || 'Authentication failed: ' + e.message);
    btn.disabled = false;
    btn.textContent = btn.dataset.originalText;
  }
}

/* ---------- views ---------- */
function thumb(t, extraClass = '') {
  return t.imageUrl
    ? `<img class="th ${extraClass}" src="${esc(t.imageUrl)}" alt="">`
    : `<div class="th ${extraClass}">${esc((t.name || '?')[0].toUpperCase())}</div>`;
}

function render(html) {
  stopChatListener();
  closeDetail();
  app.innerHTML = html;
  window.scrollTo(0, 0);
}

function viewLogin(mode = 'signin') {
  const register = mode === 'register';
  render(`<div class="center">
    <h2>Which one is better?</h2>
    <p class="sub">Add things, then settle them two at a time. Everyone's votes build one shared leaderboard.</p>
    <form id="authForm" style="margin:0 auto;text-align:left">
      <label>Email<input type="email" id="authEmail" autocomplete="email" required></label>
      <label>Password<input type="password" id="authPassword" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="6" required></label>
      <button class="primary" id="authSubmit" data-mode="${register ? 'register' : 'signin'}" type="submit">${register ? 'Create account' : 'Sign in'}</button>
      <button class="link" type="button" data-act="${register ? 'signin' : 'register'}">
        ${register ? 'Already have an account? Sign in' : 'Need an account? Register'}
      </button>
    </form>
  </div>`);
  $('#authForm').onsubmit = submitAuth;
}

function viewHome() {
  duel = null;
  render(`<h2>What now?</h2>
    <p class="sub">${things.length} thing${things.length === 1 ? '' : 's'} in the pool.</p>
    <div class="home">
      <button class="tile" data-act="add"><b>Add a thing</b><span>Give it a name, a picture and a description.</span></button>
      <button class="tile" data-act="rankmenu"><b>Rank things</b><span>Pick winners, one matchup at a time.</span></button>
      <button class="tile" data-act="board"><b>Leaderboard</b><span>See how everything stacks up.</span></button>
      <button class="tile" data-act="chat"><b>Global chat</b><span>Talk with everyone using your selected profile picture.</span></button>
    </div>`);
}

function viewAdd() {
  render(`<h2>Add a thing</h2><p class="sub">Anything people can argue about.</p>
    <form id="addForm">
      <label>Name<input type="text" id="fName" maxlength="80" required></label>
      <label>Image URL<input type="url" id="fImageUrl" placeholder="https://example.com/image.jpg"></label>
      <label>Description<textarea id="fDesc" maxlength="600"></textarea></label>
      <div class="row">
        <button class="primary" id="fSave" type="submit">Add thing</button>
        <button type="button" class="link" data-act="home">Cancel</button>
      </div>
    </form>`);
  $('#addForm').onsubmit = submitThing;
}

async function submitThing(e) {
  e.preventDefault();
  const name = $('#fName').value.trim();
  const description = $('#fDesc').value.trim();
  const imageUrl = $('#fImageUrl').value.trim();
  if (!name) return;

  const btn = $('#fSave');
  btn.disabled = true;
  btn.textContent = 'Adding...';

  try {
    const d = doc(collection(db, 'things'));
    await setDoc(d, {
      name, description, imageUrl,
      createdBy: user.uid,
      createdAt: serverTimestamp()
    });
    await loadThings();
    toast('Added ' + name);
    viewHome();
  } catch (err) {
    toast('Could not add it: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Add thing';
  }
}

function viewRankMenu() {
  duel = null;

  if (things.length < 2) {
    render(`<h2>Rank things</h2>
      <p class="sub">You need at least two things in the pool to start a matchup.</p>
      <div class="row"><button class="primary" data-act="add">Add a thing</button><button class="link" data-act="home">Back</button></div>`);
    return;
  }

  const remaining = things.reduce((n, t) =>
    n + availableOpponents(t).length, 0) / 2;

  render(`<h2>Rank things</h2>
    <p class="sub">${remaining} unique matchup${remaining === 1 ? '' : 's'} remain for you.</p>
    <div class="row">
      <button class="primary" data-act="rankrandom">Rank random things</button>
      <button class="link" data-act="home">Back</button>
    </div>
    <h2 style="font-size:20px;margin-top:32px">Or rank a specific thing</h2>
    <input type="text" id="q" placeholder="Search things" style="width:100%;max-width:420px">
    <div class="pick" id="pickList"></div>`);

  const draw = () => {
    const q = $('#q').value.toLowerCase();
    $('#pickList').innerHTML = [...things]
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter(t => t.name.toLowerCase().includes(q))
      .map(t => {
        const left = availableOpponents(t).length;
        return `<button data-act="rankone" data-id="${esc(t.id)}" ${left ? '' : 'disabled'}>
          ${thumb(t)}
          <span>${esc(t.name)} <small class="availability">${left} left</small></span>
        </button>`;
      }).join('') || '<p class="sub">Nothing matches.</p>';
  };

  $('#q').oninput = draw;
  draw();
}

function viewOutOfRankings() {
  duel = null;
  render(`<div class="center">
    <h2>You're out of rankings to do.</h2>
    <p class="sub">You've voted on every unique matchup currently available to your account. Skips do not count as votes, so skipped matchups can still appear later.</p>
    <div class="row" style="justify-content:center">
      <button class="primary" data-act="board">View leaderboard</button>
      <button class="link" data-act="home">Back home</button>
    </div>
  </div>`);
}

/* ---------- duel ---------- */
function card(t, side, extra = '') {
  const pic = t.imageUrl
    ? `<img class="pic" src="${esc(t.imageUrl)}" alt="">`
    : `<div class="pic">${esc((t.name || '?')[0].toUpperCase())}</div>`;

  return `<button class="opt ${side} ${extra}" data-act="vote" data-side="${side}">
    ${pic}
    <div class="t"><b>${esc(t.name)}</b><span>${esc(t.description)}</span></div>
  </button>`;
}

function viewDuel() {
  if (!duel) return;
  const {a, b, anchor, count} = duel;

  render(`<h2>Which is better?</h2>
    <p class="sub">${anchor ? `Ranking <b>${esc(anchor.name)}</b>. ` : ''}${count} vote${count === 1 ? '' : 's'} this session.</p>
    <div class="duel">
      ${card(a, 'l', anchor ? 'anchor' : '')}
      <div class="vs">vs</div>
      ${card(b, 'r')}
    </div>
    <div class="row duel-actions" style="margin-top:22px">
      <button class="skip" data-act="skip">Skip</button>
      <button data-act="stop">Stop ranking</button>
    </div>`);
}

async function vote(side) {
  if (!duel) return;

  const {a, b, anchor} = duel;
  const win = side === 'l' ? a : b;
  const lose = side === 'l' ? b : a;
  const id = pairId(a.id, b.id);

  if (userVotes.has(id)) {
    toast('You already voted on this matchup.');
    advanceAfterDuel(anchor, win);
    return;
  }

  const buttons = document.querySelectorAll('.opt, .skip, [data-act="stop"]');
  buttons.forEach(b => b.disabled = true);

  try {
    await recordResult(win, lose);
    duel.count++;

    if (anchor) {
      const next = rand(availableOpponents(anchor, [b.id]));
      if (next) {
        duel.a = anchor;
        duel.b = next;
        viewDuel();
      } else {
        const nextDuel = nextRandomizedDuel([anchor.id]);
        if (!nextDuel) viewOutOfRankings();
        else {
          toast(`No new matchups left for ${anchor.name}. Picking another character.`);
          duel = nextDuel;
          viewDuel();
        }
      }
    } else {
      const next = rand(availableOpponents(win, [lose.id]));
      if (next) {
        duel.anchor = win;
        duel.a = win;
        duel.b = next;
        viewDuel();
      } else {
        const nextDuel = nextRandomizedDuel([win.id]);
        if (!nextDuel) viewOutOfRankings();
        else {
          toast(`No new matchups left for ${win.name}. Picking another character.`);
          duel = nextDuel;
          viewDuel();
        }
      }
    }
  } catch (e) {
    toast(e.message || 'Could not save that vote.');
    viewDuel();
  }
}

function skipDuel() {
  if (!duel) return;
  const {a, b, anchor} = duel;

  /*
   * Skipping is deliberately not written to Firestore. It only advances the
   * current session. The same pair can therefore be shown again in a later
   * session.
   */
  if (anchor) {
    const next = rand(availableOpponents(anchor, [b.id]));
    if (next) {
      duel.a = anchor;
      duel.b = next;
      viewDuel();
      return;
    }

    const nextDuel = nextRandomizedDuel([anchor.id]);
    if (nextDuel) {
      toast(`No new matchups left for ${anchor.name}. Picking another character.`);
      duel = nextDuel;
      viewDuel();
    } else {
      viewOutOfRankings();
    }
    return;
  } else {
    const next = nextRandomizedDuel([a.id]);
    if (next) {
      duel = next;
      viewDuel();
      return;
    }
  }

  viewRankMenu();
}

function advanceAfterDuel(anchor, win) {
  if (anchor) {
    const next = rand(availableOpponents(anchor));
    if (next) {
      duel.a = anchor;
      duel.b = next;
      return;
    }
  } else {
    const next = rand(availableOpponents(win));
    if (next) {
      duel.anchor = win;
      duel.a = win;
      duel.b = next;
      return;
    }
  }
  const nextDuel = nextRandomizedDuel([anchor?.id, win?.id].filter(Boolean));
  duel = nextDuel;
}

/* ---------- leaderboard / tiers ---------- */
async function viewBoard() {
  render('<div class="center sub">Crunching the numbers...</div>');

  try {
    const [pairs] = await Promise.all([loadPairs(), loadThings()]);
    const rows = addTiers(bradleyTerry(things, pairs));
    window.__rows = rows;

    if (!rows.length) {
      render(`<h2>Leaderboard</h2>
        <p class="sub">Nothing here yet. Add the first thing.</p>
        <button class="primary" data-act="add">Add a thing</button>`);
      return;
    }

    const votes = pairs.reduce((s, p) =>
      s + (p.aWins || 0) + (p.bWins || 0), 0);

    render(`<div class="row" style="justify-content:space-between">
      <div>
        <h2>Leaderboard</h2>
        <p class="sub">Bradley-Terry ratings from ${votes} global votes. Click a character for details or to make them your profile picture.</p>
      </div>
      <button class="link" data-act="home">Back</button>
    </div>
    <div class="tier-legend">
      ${['S','A','B','C','D','F'].map(t => `<span class="${tierClass(t)}">${t}</span>`).join('')}
    </div>
    <table>${rows.map(t => `
      <tr class="hit ${tierClass(t.tier)}" tabindex="0" data-act="detail" data-id="${esc(t.id)}">
        <td class="n">${t.rank}</td>
        <td>
          <div class="nm">
            ${thumb(t)}
            <span>${esc(t.name)} <b class="tier-badge ${tierClass(t.tier)}">${t.tier}</b></span>
          </div>
        </td>
        <td class="s">${Math.round(t.rating)}<small>${t.games ? t.games + ' votes' : 'unranked'}</small></td>
      </tr>`).join('')}</table>`);
  } catch (e) {
    toast('Could not load the leaderboard: ' + e.message);
    viewHome();
  }
}

async function setProfilePicture(id) {
  const t = things.find(x => x.id === id);
  if (!t || !user) return;

  try {
    await setDoc(doc(db, 'users', user.uid), {
      email: user.email || '',
      profileThingId: t.id,
      updatedAt: serverTimestamp()
    }, {merge: true});

    profileThingId = t.id;
    updateHeader();
    toast(`${t.name} is now your profile picture.`);
    openDetail(id);
  } catch (e) {
    toast('Could not set profile picture: ' + e.message);
  }
}

function openDetail(id) {
  const rows = window.__rows || [];
  const i = rows.findIndex(t => t.id === id);
  const t = rows[i];
  if (!t) return;

  document.querySelectorAll('tr.sel').forEach(r => r.classList.remove('sel'));
  document.querySelector(`tr[data-id="${CSS.escape(id)}"]`)?.classList.add('sel');

  detail.innerHTML = `<button class="x" data-act="close" aria-label="Close">Close</button>
    <div class="${tierClass(t.tier)} detail-tier">
      ${t.imageUrl
        ? `<img src="${esc(t.imageUrl)}" alt="${esc(t.name)}">`
        : `<div class="ph">${esc((t.name || '?')[0].toUpperCase())}</div>`}
    </div>
    <div class="in">
      <div class="detail-tier-label ${tierClass(t.tier)}">Tier ${t.tier}</div>
      <h3>${esc(t.name)}</h3>
      <div style="color:var(--mute)">Rank ${i + 1} of ${rows.length}, rating ${Math.round(t.rating)}, ${t.games} vote${t.games === 1 ? '' : 's'}</div>
      <p>${esc(t.description) || '<span style="color:var(--mute)">No description.</span>'}</p>
      <button class="primary profile-pick" data-act="profile" data-id="${esc(t.id)}">
        ${profileThingId === t.id ? '✓ Current profile picture' : 'Set as profile picture'}
      </button>
    </div>`;

  detail.classList.add('open');
  app.classList.add('shift');
}

function closeDetail() {
  detail.classList.remove('open');
  app.classList.remove('shift');
  document.querySelectorAll('tr.sel').forEach(r => r.classList.remove('sel'));
}

/* ---------- profile / chat ---------- */
function updateHeader() {
  const t = things.find(x => x.id === profileThingId);
  $('#who').innerHTML = user
    ? `${t ? thumb(t, 'profile-thumb') : '<div class="profile-thumb th">?</div>'}
       <span>${esc(user.email || '')}</span>
       <button class="link" data-act="chat">Chat</button>
       <button class="link" data-act="logout">Sign out</button>`
    : '';
}

function stopChatListener() {
  if (chatUnsub) {
    chatUnsub();
    chatUnsub = null;
  }
}

function chatAvatarHtml(m) {
  return m.profileImageUrl
    ? `<img class="chat-avatar" src="${esc(m.profileImageUrl)}" alt="">`
    : `<div class="chat-avatar">${esc((m.email || '?')[0].toUpperCase())}</div>`;
}

function viewChat() {
  render(`<div class="chat-page">
    <div class="row" style="justify-content:space-between">
      <div><h2>Global chat</h2><p class="sub">Everyone sees the same room.</p></div>
      <button class="link" data-act="home">Back</button>
    </div>
    <div class="chat-box" id="chatBox"><div class="center sub">Loading chat...</div></div>
    <form class="chat-form" id="chatForm">
      <input type="text" id="chatInput" maxlength="500" placeholder="Write a message..." autocomplete="off" required>
      <button class="primary" type="submit">Send</button>
    </form>
  </div>`);

  $('#chatForm').onsubmit = sendChatMessage;

  const q = query(
    collection(db, 'chatMessages'),
    orderBy('createdAt', 'desc'),
    limit(100)
  );

  chatUnsub = onSnapshot(q, snap => {
    const messages = [...snap.docs]
      .reverse()
      .map(d => ({id: d.id, ...d.data()}));

    const box = $('#chatBox');
    if (!box) return;

    box.innerHTML = messages.length
      ? messages.map(m => `<div class="chat-message">
          ${chatAvatarHtml(m)}
          <div class="chat-content">
            <div class="chat-meta"><b>${esc(m.email || 'Unknown user')}</b></div>
            <div class="chat-text">${esc(m.text)}</div>
          </div>
        </div>`).join('')
      : '<div class="center sub">No messages yet. Start the conversation.</div>';

    box.scrollTop = box.scrollHeight;
  }, e => toast('Could not load chat: ' + e.message));
}

async function sendChatMessage(e) {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text || !user) return;

  const profile = things.find(t => t.id === profileThingId);
  const btn = e.submitter;
  btn.disabled = true;

  try {
    await addDoc(collection(db, 'chatMessages'), {
      uid: user.uid,
      email: user.email || '',
      text,
      profileThingId: profile?.id || null,
      profileImageUrl: profile?.imageUrl || null,
      createdAt: serverTimestamp()
    });
    input.value = '';
    input.focus();
  } catch (e) {
    toast('Could not send message: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- events ---------- */
const actions = {
  home: () => viewHome(),
  signin: () => viewLogin('signin'),
  register: () => viewLogin('register'),
  logout: () => signOut(auth),
  add: () => viewAdd(),
  rankmenu: () => viewRankMenu(),
  rankrandom: () => startDuel(null),
  rankone: el => startDuel(things.find(t => t.id === el.dataset.id)),
  vote: el => vote(el.dataset.side),
  skip: () => skipDuel(),
  stop: () => viewHome(),
  board: () => viewBoard(),
  detail: el => openDetail(el.dataset.id),
  profile: el => setProfilePicture(el.dataset.id),
  chat: () => viewChat(),
  close: () => closeDetail()
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDetail();
  if (e.key === 'Enter' && e.target.matches('tr[data-act]')) actions.detail(e.target);
});

onAuthStateChanged(auth, async u => {
  user = u;

  if (!u) {
    profileThingId = null;
    userVotes.clear();
    stopChatListener();
    updateHeader();
    viewLogin();
    return;
  }

  updateHeader();
  render('<div class="center sub">Loading...</div>');

  try {
    await Promise.all([loadThings(), loadUserVotes(), loadProfile()]);
    updateHeader();
  } catch (e) {
    toast('Could not load your account data: ' + e.message);
  }

  viewHome();
});
