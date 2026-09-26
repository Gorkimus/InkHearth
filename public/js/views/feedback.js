import { api } from '../api.js';
import { $, esc, toast } from '../ui.js';
import { view, registerRoute } from '../router.js';

// Feature requests: members drop ideas, the admin triages them in the admin
// panel. The member sees only their own requests and whether they're done.

async function feedbackView() {
  view.innerHTML = `
    <h1>Feature requests</h1>
    <p class="muted">Have an idea that would make this app better? Drop it here — the admin
    reviews everything in the admin panel.</p>
    <div class="card">
      <textarea id="fr-body" rows="3" maxlength="1000" placeholder="What would you like to be able to do?"
        style="width:100%"></textarea>
      <div style="margin-top:10px;display:flex;gap:10px;align-items:center">
        <button class="btn" id="fr-send">Send request</button>
        <span class="muted small" id="fr-note"></span>
      </div>
    </div>
    <h3 style="margin-top:22px">Your requests</h3>
    <div id="fr-list"><div class="loading">Loading…</div></div>`;

  const refresh = async () => {
    const { requests } = await api('/feedback');
    $('#fr-list').innerHTML = requests.length ? `
      <table class="lib-table">
        <thead><tr><th>Request</th><th>Sent</th><th>Status</th></tr></thead>
        <tbody>${requests.map((r) => `
          <tr>
            <td style="white-space:normal">${esc(r.body)}</td>
            <td class="muted small">${esc((r.created_at || '').slice(0, 10))}</td>
            <td>${r.status === 'done'
              ? '<span class="pill">✓ done</span>'
              : '<span class="pill">open</span>'}</td>
          </tr>`).join('')}</tbody>
      </table>`
      : '<div class="muted small">Nothing yet — your requests will show up here.</div>';
  };

  $('#fr-send').addEventListener('click', async () => {
    const btn = $('#fr-send');
    const body = $('#fr-body').value.trim();
    if (body.length < 3) return toast('Tell us a little more first');
    btn.disabled = true;
    try {
      await api('/feedback', { method: 'POST', body: { body } });
      $('#fr-body').value = '';
      toast('Request sent — thank you!');
      await refresh();
    } catch (err) {
      toast(err.message, 5000);
    } finally {
      btn.disabled = false;
    }
  });

  await refresh();
}

registerRoute('#feedback', feedbackView);
