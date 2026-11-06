const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'loans.json');

// 관리자 학번 (윤지섭)
const ADMIN_STUDENT_ID = '26-070';

const KSAIN_BASE = 'https://api.ksain.kr';
const INTEREST_RATE = 0.05;
const INTEREST_PERIOD = 24 * 60 * 60 * 1000;
const BLACKLIST_OVERDUE_MS = 7 * 24 * 60 * 60 * 1000;  // 연체 후 7일
const BLACKLIST_BAN_MS = 30 * 24 * 60 * 60 * 1000;     // 대출 금지 30일

// ─── 데이터 파일 초기화 ─────────────────────────────────────────────────────
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ loans: {} }, null, 2));
}

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { loans: {} };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── 미들웨어 ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'ksa-loan-secret-' + crypto.randomBytes(16).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24시간
}));

// ─── 인증 미들웨어 ──────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (!req.session.user.isAdmin) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  next();
}

// ─── 이자 계산 ─────────────────────────────────────────────────────────────
function calcTotal(loan) {
  if (loan.status !== 'active') return loan.amount;
  const start = loan.activatedAt || loan.requestedAt;
  const periods = Math.floor((Date.now() - start) / INTEREST_PERIOD);
  return Math.ceil(loan.amount * Math.pow(1 + INTEREST_RATE, periods));
}

// ─── API: 로그인 ────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { uid, password, type } = req.body; // type: 'student' | 'general'
  if (!uid || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });

  try {
    const endpoint = type === 'student'
      ? `${KSAIN_BASE}/auth/signin-student`
      : `${KSAIN_BASE}/auth/signin`;

    const body = type === 'student'
      ? { positionID: uid, password }
      : { uid, password };

    const ksainRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!ksainRes.ok) {
      const err = await ksainRes.text();
      return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
    }

    const data = await ksainRes.json();
    const ksainUser = data.user || data;
    const studentId = ksainUser.positionID || ksainUser.studentId || uid;
    const isAdmin = studentId === ADMIN_STUDENT_ID;

    req.session.user = {
      uid: ksainUser.uid || ksainUser.id || uid,
      name: ksainUser.name || ksainUser.displayName || uid,
      studentId,
      isAdmin,
      ksainToken: data.token || null,
    };

    res.json({
      ok: true,
      user: {
        uid: req.session.user.uid,
        name: req.session.user.name,
        studentId,
        isAdmin,
      }
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// ─── API: 로그아웃 ──────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ─── API: 현재 사용자 ────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const { uid, name, studentId, isAdmin } = req.session.user;
  res.json({ user: { uid, name, studentId, isAdmin } });
});

// ─── API: 대출 목록 ─────────────────────────────────────────────────────────
app.get('/api/loans', requireLogin, (req, res) => {
  const data = readData();
  const loans = Object.values(data.loans).sort((a, b) => b.requestedAt - a.requestedAt);

  if (req.session.user.isAdmin) {
    // 관리자: 현재 이자 포함 전체 반환
    const result = loans.map(l => ({ ...l, currentTotal: calcTotal(l) }));
    return res.json({ loans: result });
  }

  // 일반 사용자: 본인 대출만
  const myLoans = loans
    .filter(l => l.borrowerUid === req.session.user.uid)
    .map(l => ({ ...l, currentTotal: calcTotal(l) }));
  res.json({ loans: myLoans });
});

// ─── API: 대출 신청 ─────────────────────────────────────────────────────────
app.post('/api/loans', requireLogin, (req, res) => {
  const { amount, dueDate } = req.body;
  const user = req.session.user;

  if (!amount || amount < 1) return res.status(400).json({ error: '금액을 입력해주세요.' });
  if (!dueDate || new Date(dueDate).getTime() <= Date.now())
    return res.status(400).json({ error: '상환 날짜는 오늘 이후여야 합니다.' });

  const data = readData();
  // 중복 신청 체크
  const existing = Object.values(data.loans).find(
    l => l.borrowerUid === user.uid && (l.status === 'active' || l.status === 'pending')
  );
  if (existing) return res.status(400).json({ error: '이미 진행 중인 대출이 있습니다.' });

  const id = crypto.randomBytes(4).toString('hex').toUpperCase();
  const loan = {
    id,
    borrowerUid: user.uid,
    borrowerName: user.name,
    borrowerStudentId: user.studentId,
    amount: parseInt(amount),
    requestedAt: Date.now(),
    dueDate: new Date(dueDate).getTime(),
    status: 'pending',
    activatedAt: null,
    paidAmount: null,
    paidAt: null,
  };

  data.loans[id] = loan;
  writeData(data);
  res.json({ ok: true, loan });
});

// ─── API: 대출 상태 변경 (관리자) ───────────────────────────────────────────
app.patch('/api/loans/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { action, paidAmount } = req.body;
  const data = readData();
  const loan = data.loans[id];

  if (!loan) return res.status(404).json({ error: '대출을 찾을 수 없습니다.' });

  if (action === 'approve') {
    if (loan.status !== 'pending') return res.status(400).json({ error: '대기 중인 대출만 승인할 수 있습니다.' });
    loan.status = 'active';
    loan.activatedAt = Date.now();
  } else if (action === 'reject') {
    if (loan.status !== 'pending') return res.status(400).json({ error: '대기 중인 대출만 거절할 수 있습니다.' });
    loan.status = 'rejected';
  } else if (action === 'repay') {
    if (loan.status !== 'active') return res.status(400).json({ error: '진행 중인 대출만 상환 처리할 수 있습니다.' });
    loan.status = 'repaid';
    loan.paidAmount = paidAmount || calcTotal(loan);
    loan.paidAt = Date.now();
  } else if (action === 'default') {
    if (loan.status !== 'active') return res.status(400).json({ error: '진행 중인 대출만 처리할 수 있습니다.' });
    loan.status = 'defaulted';
    loan.paidAt = Date.now();
  } else {
    return res.status(400).json({ error: '알 수 없는 액션입니다.' });
  }

  writeData(data);
  res.json({ ok: true, loan: { ...loan, currentTotal: calcTotal(loan) } });
});

// ─── 서버 시작 ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏦 KSA 포인트 대출 서버 실행 중`);
  console.log(`📡 http://localhost:${PORT}\n`);
});
