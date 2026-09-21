let allQuestions = [];
(async function init() {
  try { const res = await fetch('/api/me'); if (!res.ok) { location.href = '/'; return; } const data = await res.json(); if (!data.user || !data.user.isAdmin) { location.href = '/?error=no_admin'; return; } } catch (_) { location.href = '/'; return; }
  await loadQuestions();
})();
async function loadQuestions() { const res = await fetch('/api/questions'); allQuestions = await res.json(); render(); }
function render() {
  const cat = document.getElementById('filter-category').value; const search = document.getElementById('filter-search').value.toLowerCase();
  const filtered = allQuestions.filter(q => { if (cat && q.category !== cat) return false; if (search && !(q.question.toLowerCase().includes(search) || q.answer.toLowerCase().includes(search))) return false; return true; });
  document.getElementById('total-count').innerText = filtered.length; const tbody = document.getElementById('questions-tbody');
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#999;">Brak pytań.</td></tr>'; return; }
  tbody.innerHTML = filtered.map(q => `<tr><td>${q.id}</td><td><span class="tag ${q.category}">${q.category}</span></td><td>${q.rank_min}–${q.rank_max}</td><td>${escapeHtml(q.question)}</td><td>${escapeHtml(q.answer)}</td><td class="row-actions"><button class="edit" onclick="openEdit(${q.id})">Edytuj</button><button class="del" onclick="deleteQuestion(${q.id})">Usuń</button></td></tr>`).join('');
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }
function openAdd() { document.getElementById('modal-title').innerText = 'Dodaj pytanie'; document.getElementById('edit-id').value = ''; document.getElementById('edit-category').value = 'regulamin'; document.getElementById('edit-rank-min').value = 1; document.getElementById('edit-rank-max').value = 13; document.getElementById('edit-question').value = ''; document.getElementById('edit-answer').value = ''; document.getElementById('modal').classList.add('open'); }
function openEdit(id) { const q = allQuestions.find(x => x.id === id); if (!q) return; document.getElementById('modal-title').innerText = 'Edytuj pytanie #' + id; document.getElementById('edit-id').value = id; document.getElementById('edit-category').value = q.category; document.getElementById('edit-rank-min').value = q.rank_min; document.getElementById('edit-rank-max').value = q.rank_max; document.getElementById('edit-question').value = q.question; document.getElementById('edit-answer').value = q.answer; document.getElementById('modal').classList.add('open'); }
function closeModal() { document.getElementById('modal').classList.remove('open'); }
async function saveQuestion() {
  const id = document.getElementById('edit-id').value;
  const payload = { category: document.getElementById('edit-category').value, rank_min: Number(document.getElementById('edit-rank-min').value), rank_max: Number(document.getElementById('edit-rank-max').value), question: document.getElementById('edit-question').value.trim(), answer: document.getElementById('edit-answer').value.trim() };
  if (!payload.question || !payload.answer) { alert('Uzupełnij pytanie i odpowiedź.'); return; }
  const url = id ? '/api/questions/' + id : '/api/questions'; const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) { alert('Błąd zapisu.'); return; } closeModal(); await loadQuestions();
}
async function deleteQuestion(id) { if (!confirm('Usunąć to pytanie?')) return; const res = await fetch('/api/questions/' + id, { method: 'DELETE' }); if (!res.ok) { alert('Błąd usuwania.'); return; } await loadQuestions(); }
document.getElementById('add-btn').addEventListener('click', openAdd);
document.getElementById('filter-category').addEventListener('change', render);
document.getElementById('filter-search').addEventListener('input', render);
document.getElementById('export-btn').addEventListener('click', () => { window.location.href = '/api/questions/export'; });
document.getElementById('import-btn').addEventListener('click', () => { const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json'; input.onchange = async () => { const file = input.files[0]; if (!file) return; const text = await file.text(); let data; try { data = JSON.parse(text); } catch (e) { alert('Nieprawidłowy JSON'); return; } if (!confirm(`Zaimportować ${data.length} pytań?`)) return; const res = await fetch('/api/questions/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); if (res.ok) { await loadQuestions(); alert('Zaimportowano!'); } else alert('Błąd importu.'); }; input.click(); });
async function logout() { await fetch('/auth/logout', { method: 'POST' }); location.href = '/'; }
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });