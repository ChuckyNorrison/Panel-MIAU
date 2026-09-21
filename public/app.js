let user = null; let allQuestions = []; let dbRegulamin = [], dbKody = [];
let s1Qs = [], s2Qs = [], s3Qs = [], s1Pts = [], s2Pts = [], s3Pts = [];

(async function init() {
  const params = new URLSearchParams(location.search);
  const err = params.get('error');
  if (err) {
    document.getElementById('loading-section').style.display = 'none';
    document.getElementById('login-section').style.display = 'block';
    const map = { not_in_guild: 'Nie należysz do wymaganego serwera Discord.', missing_role: 'Nie posiadasz wymaganej roli na serwerze.', token_failed: 'Błąd wymiany tokenu OAuth.', auth_failed: 'Błąd autoryzacji.', no_code: 'Brak kodu autoryzacyjnego.' };
    document.getElementById('login-error').innerText = map[err] || ('Błąd: ' + err); return;
  }
  try { const res = await fetch('/api/me'); if (res.ok) { const data = await res.json(); user = data.user; } } catch (_) {}
  if (!user) { document.getElementById('loading-section').style.display = 'none'; document.getElementById('login-section').style.display = 'block'; return; }
  document.getElementById('loading-section').style.display = 'none';
  document.getElementById('app-section').style.display = 'block';
  document.getElementById('user-info').innerText = '👤 ' + (user.globalName || user.username);
  if (user.isAdmin) document.getElementById('admin-link').style.display = 'inline-block';
  try {
    const qRes = await fetch('/api/questions'); allQuestions = await qRes.json();
    dbRegulamin = allQuestions.filter(q => q.category === 'regulamin');
    dbKody = allQuestions.filter(q => q.category === 'kody');
  } catch (e) { alert('Błąd wczytywania bazy pytań: ' + e.message); }
})();

async function logout() { await fetch('/auth/logout', { method: 'POST' }); location.href = '/'; }

document.getElementById('start-btn').addEventListener('click', startExam);
function startExam() {
  const nameInput = document.getElementById('examinee-name').value.trim();
  const rankSelect = document.getElementById('rank-select').value;
  const errorMsg = document.getElementById('error-msg');
  if (!nameInput || !rankSelect) { errorMsg.innerText = 'Podaj nazwę osoby egzaminowanej oraz wybierz stopień!'; return; }
  errorMsg.innerText = '';
  const rankNum = parseInt(rankSelect);
  s1Pts = new Array(4).fill(null); s2Pts = new Array(4).fill(null); s3Pts = new Array(10).fill(null);
  s1Qs = shuffle(dbRegulamin).slice(0, 4); renderStageContent('stage-1-questions', s1Qs, 's1', 0.5);
  s2Qs = shuffle(dbKody).slice(0, 4); renderStageContent('stage-2-questions', s2Qs, 's2', 0.5);
  const effectiveRank = Math.max(2, rankNum);
  const medPool = allQuestions.filter(q => q.category === 'medycyna').filter(q => q.rank_min <= effectiveRank && q.rank_max >= effectiveRank);
  s3Qs = shuffle(medPool).slice(0, 10);
  if (s3Qs.length < 10) { errorMsg.innerText = `Za mało pytań medycznych dla rangi ${rankNum}.`; return; }
  renderStageContent('stage-3-questions', s3Qs, 's3', 1);
  document.getElementById('setup-section').style.display = 'none';
  document.getElementById('stage-1').style.display = 'block';
}

function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function renderStageContent(containerId, questionsArray, prefix, maxPoints) {
  const neutralPoints = maxPoints / 2; let html = '';
  questionsArray.forEach((item, index) => {
    html += `<div class="question-card"><div class="question-text">${index + 1}. ${escapeHtml(item.question)}</div><div class="answer-text"><strong>Oczekiwana odpowiedź:</strong> ${escapeHtml(item.answer)}</div><div class="grading-buttons"><button type="button" onclick="setPoint('${prefix}', ${index}, ${maxPoints}, 'correct', this)">Poprawna (${maxPoints} pkt)</button><button type="button" onclick="setPoint('${prefix}', ${index}, ${neutralPoints}, 'neutral', this)">Neutral (${neutralPoints} pkt)</button><button type="button" onclick="setPoint('${prefix}', ${index}, 0, 'wrong', this)">Błędna (0 pkt)</button></div></div>`;
  });
  document.getElementById(containerId).innerHTML = html;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }
function setPoint(stagePrefix, index, points, type, btnElement) {
  if (stagePrefix === 's1') s1Pts[index] = points; if (stagePrefix === 's2') s2Pts[index] = points; if (stagePrefix === 's3') s3Pts[index] = points;
  const parent = btnElement.parentElement; parent.querySelectorAll('button').forEach(b => b.classList.remove('selected-correct', 'selected-neutral', 'selected-wrong'));
  btnElement.classList.add('selected-' + type);
}
function nextStage(currentStage) {
  const errorMsg = document.getElementById('error-msg');
  if (currentStage === 1 && s1Pts.includes(null)) { errorMsg.innerText = 'Oceń pytania z Etapu 1!'; return; }
  if (currentStage === 2 && s2Pts.includes(null)) { errorMsg.innerText = 'Oceń pytania z Etapu 2!'; return; }
  errorMsg.innerText = '';
  document.getElementById('stage-' + currentStage).style.display = 'none';
  document.getElementById('stage-' + (currentStage + 1)).style.display = 'block'; window.scrollTo(0, 0);
}
function finishExam() {
  const errorMsg = document.getElementById('error-msg');
  if (s3Pts.includes(null)) { errorMsg.innerText = 'Oceń wszystkie 10 pytań z Etapu 3!'; return; }
  const totalPoints = s1Pts.reduce((a, b) => a + b, 0) + s2Pts.reduce((a, b) => a + b, 0) + s3Pts.reduce((a, b) => a + b, 0);
  const maxPoints = 14; const percent = (totalPoints / maxPoints) * 100;
  const verdict = (percent === 100) ? 'plus' : (percent >= 50) ? 'neutral' : 'minus';
  const allQ = [...s1Qs, ...s2Qs, ...s3Qs]; const topicsStr = allQ.map(item => item.question).join(' | ');
  const examineeName = document.getElementById('examinee-name').value.trim();
  const finalCommand = `/kontrola kogo:${examineeName} temat: ${topicsStr} werdykt: ${verdict}`;
  document.getElementById('score-text').innerHTML = `Zdobyte punkty: <strong>${totalPoints} / ${maxPoints} (${percent.toFixed(0)}%)</strong><br>Ostateczny wynik: <strong>${verdict.toUpperCase()}</strong>`;
  document.getElementById('command-output').value = finalCommand; document.getElementById('result-section').style.display = 'block';
  document.getElementById('stage-3').style.display = 'none'; window.scrollTo(0, 0);
}
function copyCommand() { const copyText = document.getElementById('command-output'); copyText.select(); navigator.clipboard.writeText(copyText.value).then(() => alert('Skopiowano!')); }