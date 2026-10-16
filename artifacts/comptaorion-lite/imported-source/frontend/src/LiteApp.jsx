import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from './api';
import { Login } from './pages/Login';
import { cacheRead, cacheWrite, listQueue, queueWrite, removeQueue } from './liteDb';
import './lite.css';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const money = (v, currency = 'FCFA') => `${Math.round(Number(v) || 0).toLocaleString('fr-FR')} ${currency}`;
const unwrap = (r) => r?.data?.data || r?.data || r || [];
const dateOf = (x) => String(x || '').slice(0, 10);
const operationId = () => `lite-${Date.now().toString(36)}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function Modal({ title, children, onClose }) {
  return <div className="lite-modal-backdrop" role="presentation"><section className="lite-modal" role="dialog" aria-modal="true">
    <header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Fermer">×</button></header>{children}
  </section></div>;
}

export default function LiteApp({ onLogout }) {
  const [user, setUser] = useState(() => JSON.parse(localStorage.getItem('user') || 'null'));
  if (!localStorage.getItem('token') || !user) return <Login onLoginSuccess={setUser} />;
  return <LiteShell user={user} onLogout={onLogout} />;
}

function LiteShell({ user, onLogout }) {
  const [page, setPage] = useState('today');
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  const [pendingItems, setPendingItems] = useState([]);
  const [settings, setSettings] = useState(() => JSON.parse(localStorage.getItem(`lite-settings-${user.id || user.entrepriseId}`) || '{"language":"fr","currency":"FCFA"}'));
  const [installPrompt, setInstallPrompt] = useState(null);
  const [toast, setToast] = useState('');
  const scope = `${user.entrepriseId || 'company-none'}:${user.id || 'user-none'}`;
  const [data, setData] = useState({ clients: [], invoices: [], products: [], expenses: [], lowStock: [], daySummary: null });
  const t = (fr, en) => settings.language === 'fr' ? fr : en;
  const refreshQueue = useCallback(async () => {
    const items = await listQueue(scope);
    setPendingItems(items);
    setPending(items.length);
    return items;
  }, [scope]);
  const syncQueue = useCallback(async () => {
    if (!navigator.onLine) return;
    const items = await listQueue(scope);
    for (const item of items) {
      if (!['/factures/lite-sale', '/depenses/create'].includes(item.endpoint)) continue;
      try { await api.post(item.endpoint, item.payload, { headers: { 'X-Idempotency-Key': item.opId } }); await removeQueue(scope, item.opId); }
      catch (error) { if (error?.status === 409) setToast(t('Synchronisation en cours côté serveur, nouvelle tentative plus tard.', 'Server is still processing this operation; it will be retried later.')); break; }
    }
    refreshQueue();
  }, [refreshQueue, scope, settings.language]);
  const write = useCallback(async (endpoint, payload, optimistic, existingOperationId) => {
    const opId = existingOperationId || operationId();
    const queueable = endpoint === '/factures/lite-sale' || endpoint === '/depenses/create';
    if (!navigator.onLine) {
      if (!queueable) { setToast(t('Cette opération nécessite une connexion.', 'This operation requires a connection.')); return { failed: true, offline: true }; }
      await queueWrite(scope, opId, endpoint, payload); await refreshQueue(); setToast(t('Enregistré sur cet appareil — en attente de synchronisation', 'Saved on this device — waiting to sync')); return { queued: true, opId };
    }
    try { const result = await api.post(endpoint, payload, { headers: { 'X-Idempotency-Key': opId } }); setToast(t('Enregistré', 'Saved')); return result; }
    catch (e) {
      if (e instanceof TypeError || /failed to fetch|network|offline/i.test(e?.message || '')) {
        if (!queueable) { setToast(t('Connexion instable : cette opération n’a pas été enregistrée. Réessayez.', 'Connection failed: this operation was not saved. Please retry.')); return { failed: true, offline: true }; }
        await queueWrite(scope, opId, endpoint, payload); await refreshQueue(); setToast(t('Réseau indisponible — mis en attente, rien n’est perdu', 'Network unavailable — queued safely')); return { queued: true, opId };
      }
      setToast(e?.message || t('Impossible d’enregistrer', 'Could not save'));
      return { failed: true, error: e };
    }
  }, [refreshQueue, scope, settings.language]);
  const load = useCallback(async () => {
    const key = `lite-data-${user.entrepriseId || user.id}`;
    try {
      const [c, f, p, e, l, d] = await Promise.all([api.get('/clients', { limit: 100 }), api.get('/factures', { limit: 100 }), api.get('/produits', { limit: 100 }), api.get('/depenses/list'), api.get('/produits/stock-faible'), api.get('/factures/lite-day', { date: today() })]);
      const next = { clients: unwrap(c), invoices: unwrap(f).map(x => ({ ...(x.facture || x), client: x.client })), products: unwrap(p), expenses: unwrap(e), lowStock: unwrap(l), daySummary: d?.data || null };
      setData(next); await cacheWrite(key, next);
    } catch { const cached = await cacheRead(key); if (cached) setData(cached); }
  }, [user.entrepriseId, user.id]);
  const visibleData = useMemo(() => {
    const invoices = [...data.invoices];
    const expenses = [...data.expenses];
    let pendingSales = 0;
    let pendingPayments = 0;
    pendingItems.forEach((item) => {
      if (item.endpoint === '/factures/lite-sale') {
        const payload = item.payload || {};
        const client = payload.clientId
          ? data.clients.find(c => Number(c.id) === Number(payload.clientId))
          : payload.newClient;
        const subtotal = (payload.items || []).reduce(
          (sum, line) => sum + Number(line.quantite || 0) * Number(line.prixUnitaire || 0),
          0
        );
        const vatRate = Number(data.daySummary?.tauxTva ?? 18);
        const total = subtotal * (1 + vatRate / 100);
        const paid = Number(payload.paiement?.montant || 0);
        invoices.unshift({
          id: `pending-${item.opId}`,
          clientId: payload.clientId,
          client: client ? { id: client.id, nom: client.nom, telephone: client.telephone } : null,
          dateFacture: payload.dateFacture || today(),
          totalHT: subtotal,
          totalTTC: total,
          montantPaye: paid,
          soldeRestant: Math.max(0, total - paid),
          statut: 'en_attente_sync',
          numeroFacture: t('En attente de synchronisation', 'Pending sync'),
          pendingSync: true,
          items: payload.items || [],
        });
        if ((payload.dateFacture || today()) === today()) pendingSales += total;
        if (paid > 0 && (payload.paiement?.datePaiement || payload.dateFacture || today()) === today()) {
          pendingPayments += paid;
        }
      } else if (item.endpoint === '/depenses/create') {
        const payload = item.payload || {};
        expenses.unshift({
          id: `pending-${item.opId}`,
          description: payload.description,
          montant: Number(payload.montant || 0),
          dateDepense: payload.dateDepense || today(),
          statut: 'en_attente_sync',
          pendingSync: true,
        });
      }
    });
    const daySummary = {
      ...(data.daySummary || { date: today(), ventes: 0, encaissements: 0, nombreVentes: 0, nombrePaiements: 0 }),
      ventes: Number(data.daySummary?.ventes || 0) + pendingSales,
      encaissements: Number(data.daySummary?.encaissements || 0) + pendingPayments,
    };
    return { ...data, invoices, expenses, daySummary };
  }, [data, pendingItems, t]);
  useEffect(() => { load(); refreshQueue(); const on = () => { setOnline(true); syncQueue(); load(); }; const off = () => setOnline(false); const install = (e) => { e.preventDefault(); setInstallPrompt(e); }; window.addEventListener('online', on); window.addEventListener('offline', off); window.addEventListener('beforeinstallprompt', install); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); window.removeEventListener('beforeinstallprompt', install); }; }, [load, refreshQueue, syncQueue]);
  useEffect(() => { if (toast) { const id = setTimeout(() => setToast(''), 3200); return () => clearTimeout(id); } }, [toast]);
  const logout = () => { localStorage.removeItem('token'); localStorage.removeItem('refreshToken'); localStorage.removeItem('user'); onLogout?.(); };
  const saveSettings = (next) => { setSettings(next); localStorage.setItem(`lite-settings-${user.id || user.entrepriseId}`, JSON.stringify(next)); setToast(t('Préférences enregistrées', 'Preferences saved')); };
  const nav = [
    ['today', t('Aujourd’hui', 'Today'), '⌂'], ['sales', t('Ventes', 'Sales'), '+'], ['debts', t('Clients & dettes', 'Customers & debts'), '◎'],
    ['expenses', t('Dépenses', 'Expenses'), '−'], ['stock', t('Stock', 'Stock'), '□'], ['reports', t('Reçus & rapports', 'Receipts & reports'), '▤'], ['settings', t('Réglages', 'Settings'), 'S']
  ];
  return <div className="lite-app">
    <aside className="lite-sidebar"><div className="lite-brand"><img src="/logo-comptaorion.png" alt="" /><span>ComptaOrion <b>Lite</b></span></div><nav>{nav.map(([id, label, mark]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}><i>{mark}</i>{label}</button>)}</nav><div className="lite-side-foot"><span className="avatar">{(user.prenom || user.nom || 'O').slice(0, 1).toUpperCase()}</span><span>{user.prenom || user.nom || 'Mon entreprise'}</span></div></aside>
     <main className="lite-main"><header className="lite-topbar"><div><span className={`network-dot ${online ? 'is-online' : ''}`}></span>{online ? t('En ligne', 'Online') : t('Hors connexion', 'Offline')}</div><div className="top-actions">{pending > 0 && <button className="sync-pill" onClick={syncQueue}>{pending} {t('à synchroniser', 'pending')}</button>}<button className="mobile-menu" onClick={() => setPage('today')}>ComptaOrion <b>Lite</b></button></div></header><div className="lite-content"><div className="lite-page">{page === 'today' && <Today data={visibleData} settings={settings} t={t} setPage={setPage} />}
        {page === 'sales' && <Sales data={visibleData} settings={settings} t={t} write={write} reload={load} notify={setToast} />}
      {page === 'debts' && <Debts data={data} settings={settings} t={t} write={write} reload={load} />}
       {page === 'expenses' && <Expenses data={visibleData} user={user} settings={settings} t={t} write={write} reload={load} />}
       {page === 'stock' && <Stock data={visibleData} settings={settings} t={t} write={write} reload={load} />}
       {page === 'reports' && <LiteReports data={visibleData} settings={settings} t={t} />}
      {page === 'settings' && <Settings settings={settings} saveSettings={saveSettings} t={t} logout={logout} installPrompt={installPrompt} />}
    </div></div>{toast && <div className="lite-toast">{toast}<span></span></div>}<nav className="lite-bottom-nav">{nav.slice(0, 5).map(([id, label, mark]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}><i>{mark}</i><small>{label}</small></button>)}<button className={page === 'reports' || page === 'settings' ? 'active' : ''} onClick={() => setPage(page === 'reports' ? 'settings' : 'reports')}><i>•••</i><small>{page === 'reports' ? t('Réglages', 'Settings') : t('Plus', 'More')}</small></button></nav></main>
  </div>;
}

function PageHead({ eyebrow, title, action, children }) { return <div className="lite-page-head"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{children}</div>{action}</div>; }
function Today({ data, settings, t, setPage }) {
  const day = today(), sales = data.invoices.filter(i => dateOf(i.dateFacture) === day && i.statut !== 'annulee'), expenses = data.expenses.filter(e => dateOf(e.dateDepense) === day);
  const totalSales = Number(data.daySummary?.ventes ?? sales.reduce((s, x) => s + Number(x.totalTTC || 0), 0)), totalReceived = Number(data.daySummary?.encaissements ?? sales.reduce((s, x) => s + Number(x.montantPaye || 0), 0)), totalExpenses = expenses.reduce((s, x) => s + Number(x.montant || 0), 0), debts = data.invoices.reduce((s, x) => s + Number(x.soldeRestant || 0), 0);
  return <><PageHead eyebrow={new Date().toLocaleDateString(settings.language === 'fr' ? 'fr-FR' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} title={t('Bonjour, voici votre journée.', 'Good morning, here is your day.')}><p className="muted">{t('Les chiffres essentiels, sans détour.', 'The essentials, without the noise.')}</p></PageHead>
    <section className="hero-metric"><span>{t('Solde de caisse du jour', 'Today’s cash balance')}</span><strong>{money(totalReceived - totalExpenses, settings.currency)}</strong><small>{t('Encaissements moins dépenses du jour', 'Today’s payments received minus expenses')}</small></section>
    <div className="metric-grid"><Metric label={t('Ventes du jour', 'Today’s sales')} value={money(totalSales, settings.currency)} tone="coral" /><Metric label={t('Dépenses', 'Expenses')} value={money(totalExpenses, settings.currency)} tone="sand" /><Metric label={t('Impayés', 'Unpaid')} value={money(debts, settings.currency)} tone="ink" /><Metric label={t('Stock faible', 'Low stock')} value={data.lowStock.length} tone="mint" /></div>
    <section className="quick-actions"><div className="section-title"><h2>{t('Gagner du temps', 'Save time')}</h2><span>{t('Actions rapides', 'Quick actions')}</span></div><div className="action-grid"><button onClick={() => setPage('sales')}><b>+</b><span>{t('Nouvelle vente', 'New sale')}</span></button><button onClick={() => setPage('expenses')}><b>−</b><span>{t('Ajouter une dépense', 'Add expense')}</span></button><button onClick={() => setPage('debts')}><b>◎</b><span>{t('Relancer un client', 'Remind customer')}</span></button></div></section>
    <section className="activity"><div className="section-title"><h2>{t('Dernière activité', 'Recent activity')}</h2><button onClick={() => setPage('reports')}>{t('Voir tout', 'View all')}</button></div>{[...sales, ...expenses].slice(0, 5).map((x, i) => <div className="activity-row" key={x.id || i}><span className={`activity-mark ${x.montant ? 'out' : 'in'}`}>{x.montant ? '−' : '+'}</span><div><strong>{x.montant ? x.description : x.client?.nom || t('Vente comptant', 'Cash sale')}</strong><small>{dateOf(x.dateDepense || x.dateFacture)}</small></div><b>{money(x.montant || x.totalTTC, settings.currency)}</b></div>)}{sales.length + expenses.length === 0 && <Empty text={t('Votre journée commence ici.', 'Your day starts here.')} />}</section>
  </>;
}
function Metric({ label, value, tone }) { return <div className={`metric-card ${tone}`}><span>{label}</span><strong>{value}</strong></div>; }
function Empty({ text, secondary }) { return <div className="empty-state"><strong>{text}</strong><span>{secondary || 'Ajoutez votre première opération pour la voir apparaître ici. / Add your first operation to see it here.'}</span></div>; }

function Sales({ data, settings, t, write, reload, notify }) {
  const [open, setOpen] = useState(false), [client, setClient] = useState(''), [search, setSearch] = useState(''), [items, setItems] = useState([{ description: '', quantite: 1, prixUnitaire: 0, produitId: '' }]), [paid, setPaid] = useState(0), [newClient, setNewClient] = useState(false), [newName, setNewName] = useState(''), [newPhone, setNewPhone] = useState('');
  const subtotal = items.reduce((s, i) => s + Number(i.quantite || 0) * Number(i.prixUnitaire || 0), 0);
  const updateItem = (index, changes) => setItems(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item));
  const updateProduct = (index, value) => {
    const product = data.products.find(p => String(p.id) === value);
    updateItem(index, { produitId: value, description: product?.nom || '', prixUnitaire: product?.prixVente ?? 0 });
  };
  const addItem = () => setItems(current => [...current, { description: '', quantite: 1, prixUnitaire: 0, produitId: '' }]);
  const removeItem = (index) => setItems(current => current.length === 1 ? current : current.filter((_, itemIndex) => itemIndex !== index));
  const submit = async (e) => {
    e.preventDefault();
    if ((!client && !newName) || items.some(item => !item.description.trim() || Number(item.quantite) <= 0 || Number(item.prixUnitaire) < 0)) return;
    const result = await write('/factures/lite-sale', {
      ...(client ? { clientId: Number(client) } : { newClient: { nom: newName, telephone: newPhone } }),
      dateFacture: today(), dateEcheance: today(),
      paiement: Number(paid) > 0 ? { montant: Number(paid), modePaiement: 'especes', datePaiement: today() } : undefined,
      notes: 'Créée depuis ComptaOrion Lite',
      items: items.map(i => ({ produitId: i.produitId ? Number(i.produitId) : undefined, description: i.description, quantite: Number(i.quantite), prixUnitaire: Number(i.prixUnitaire), remise: 0 }))
    });
    if (result?.failed) return;
    setOpen(false); setPaid(0); setItems([{ description: '', quantite: 1, prixUnitaire: 0, produitId: '' }]); reload();
  };
  const filtered = data.invoices.filter(i => !search || (i.client?.nom || '').toLowerCase().includes(search.toLowerCase())).slice(0, 6);
  return <><PageHead eyebrow={t('Encaissement', 'Revenue')} title={t('Ventes', 'Sales')} action={<button className="primary" onClick={() => setOpen(true)}>+ {t('Nouvelle vente', 'New sale')}</button>}><p className="muted">{t('Une facture claire en moins de 30 secondes.', 'A clear invoice in under 30 seconds.')}</p></PageHead><div className="search-row"><input placeholder={t('Rechercher une vente ou un client', 'Search sales or customer')} value={search} onChange={e => setSearch(e.target.value)} /></div><section className="list-card">{filtered.map(i => <div className="invoice-row" key={i.id}><div><strong>{i.client?.nom || t('Client comptant', 'Cash customer')}</strong><small>{i.numeroFacture || `#${i.id}`} · {dateOf(i.dateFacture)}</small></div><div className="align-right"><b>{money(i.totalTTC, settings.currency)}</b><span className={`status ${i.statut}`}>{i.statut}</span></div></div>)}{!filtered.length && <Empty text={t('Aucune vente récente.', 'No recent sales.')} secondary={t('Créez une vente pour commencer.', 'Create a sale to get started.')} />}</section>{open && <Modal title={t('Nouvelle vente', 'New sale')} onClose={() => setOpen(false)}><form className="lite-form" onSubmit={submit}>{!newClient ? <><label>{t('Client', 'Customer')}<select value={client} onChange={e => setClient(e.target.value)} required><option value="">{t('Choisir un client', 'Choose a customer')}</option>{data.clients.map(c => <option key={c.id} value={c.id}>{c.nom}</option>)}</select></label><button type="button" className="text-button" onClick={() => setNewClient(true)}>+ {t('Créer un client sans quitter la vente', 'Create a customer without leaving this sale')}</button></> : <><label>{t('Nom du nouveau client', 'New customer name')}<input required value={newName} onChange={e => setNewName(e.target.value)} /></label><label>{t('Téléphone WhatsApp', 'WhatsApp phone')}<input required value={newPhone} onChange={e => setNewPhone(e.target.value)} /></label><button type="button" className="text-button" onClick={() => setNewClient(false)}>{t('Choisir un client existant', 'Choose an existing customer')}</button></>}<div className="sale-items"><div className="sale-items-head"><strong>{t('Articles', 'Items')}</strong><span>{items.length}</span></div>{items.map((item, index) => <fieldset className="sale-item" key={index}><div className="sale-item-title"><strong>{t('Article', 'Item')} {index + 1}</strong>{items.length > 1 && <button type="button" className="remove-item" onClick={() => removeItem(index)} aria-label={t(`Supprimer l’article ${index + 1}`, `Remove item ${index + 1}`)}>×</button>}</div><label>{t('Produit (facultatif)', 'Product (optional)')}<select value={item.produitId} onChange={e => updateProduct(index, e.target.value)}><option value="">{t('Article libre', 'Free-text item')}</option>{data.products.map(p => <option key={p.id} value={p.id}>{p.nom} · {money(p.prixVente, settings.currency)}</option>)}</select></label><label>{t('Description', 'Description')}<input required value={item.description} onChange={e => updateItem(index, { description: e.target.value })} placeholder={t('Ex. Sac de riz', 'E.g. Bag of rice')} /></label><div className="item-numbers"><label>{t('Quantité', 'Qty')}<input type="number" min="0.01" step="0.01" required value={item.quantite} onChange={e => updateItem(index, { quantite: e.target.value })} /></label><label>{t('Prix unitaire', 'Unit price')}<input type="number" min="0" step="0.01" required value={item.prixUnitaire} onChange={e => updateItem(index, { prixUnitaire: e.target.value })} /></label><div className="line-subtotal"><span>{t('Sous-total', 'Subtotal')}</span><b>{money(Number(item.quantite || 0) * Number(item.prixUnitaire || 0), settings.currency)}</b></div></div></fieldset>)}<button type="button" className="outline add-item" onClick={addItem}>+ {t('Ajouter un article', 'Add item')}</button></div><label>{t('Paiement reçu maintenant', 'Payment received now')}<input type="number" min="0" step="0.01" value={paid} onChange={e => setPaid(e.target.value)} /></label><div className="form-total"><span>{t('Sous-total — total final calculé par le serveur', 'Subtotal — final total calculated by server')}</span><b>{money(subtotal, settings.currency)}</b></div><button className="primary wide" type="submit">{t('Enregistrer la vente', 'Save sale')}</button></form></Modal>}</>;
}

function Debts({ data, settings, t, write, reload }) {
  const [open, setOpen] = useState(null), [q, setQ] = useState(''), [amount, setAmount] = useState('');
  const debts = data.invoices.filter(i => Number(i.soldeRestant) > 0 && (!q || (i.client?.nom || '').toLowerCase().includes(q.toLowerCase())));
  const remind = (i) => { const matched = data.clients.find(c => Number(c.id) === Number(i.clientId)); const phone = (i.client?.telephone || matched?.telephone || '').replace(/\D/g, ''); if (!phone) { window.alert(t('Ce client n’a pas de numéro WhatsApp enregistré.', 'This customer has no WhatsApp number saved.')); return; } const text = encodeURIComponent(t(`Bonjour ${i.client?.nom || matched?.nom || ''}, il reste ${money(i.soldeRestant, settings.currency)} à régler pour la facture ${i.numeroFacture || ''}. Merci.`, `Hello ${i.client?.nom || matched?.nom || ''}, ${money(i.soldeRestant, settings.currency)} remains due for invoice ${i.numeroFacture || ''}. Thank you.`)); window.open(`https://wa.me/${phone}?text=${text}`, '_blank'); };
  const pay = async (e) => { e.preventDefault(); const result = await write(`/factures/${open.id}/paiement`, { montant: Number(amount), modePaiement: 'mobile_money', datePaiement: today() }); if (result?.failed) return; setOpen(null); setAmount(''); reload(); };
  return <><PageHead eyebrow={t('À recevoir', 'Money due')} title={t('Clients & dettes', 'Customers & debts')} action={<button className="primary" onClick={() => setOpen('new')}>+ {t('Nouveau client', 'New customer')}</button>}><p className="muted">{t('Relancez avec tact, encaissez plus vite.', 'Remind with care, collect faster.')}</p></PageHead><div className="search-row"><input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Nom du client', 'Customer name')} /></div><section className="list-card">{debts.map(i => <div className="debt-row" key={i.id}><div className="avatar small">{(i.client?.nom || '?').slice(0, 1)}</div><div className="grow"><strong>{i.client?.nom || t('Client inconnu', 'Unknown customer')}</strong><small>{i.numeroFacture} · {t('Reste à payer', 'Remaining')}</small></div><b className="debt-amount">{money(i.soldeRestant, settings.currency)}</b><button className="text-button" onClick={() => remind(i)}>{t('WhatsApp', 'WhatsApp')}</button><button className="outline" onClick={() => setOpen(i)}>{t('Paiement', 'Payment')}</button></div>)}{!debts.length && <Empty text={t('Aucune dette en cours.', 'No outstanding debt.')} />}</section>{open && open !== 'new' && <Modal title={t('Enregistrer un paiement', 'Record payment')} onClose={() => setOpen(null)}><form className="lite-form" onSubmit={pay}><p>{open.client?.nom} · {money(open.soldeRestant, settings.currency)}</p><label>{t('Montant reçu', 'Amount received')}<input autoFocus type="number" min="1" max={open.soldeRestant} value={amount} onChange={e => setAmount(e.target.value)} required /></label><button className="primary wide">{t('Confirmer', 'Confirm')}</button></form></Modal>}{open === 'new' && <CustomerModal onClose={() => setOpen(null)} write={write} reload={reload} t={t} />}</>;
}
function CustomerModal({ onClose, write, reload, t }) { const [name, setName] = useState(''), [phone, setPhone] = useState(''); const submit = async e => { e.preventDefault(); const result = await write('/clients', { nom: name, telephone: phone, type: 'particulier' }); if (result?.failed) return; onClose(); reload(); }; return <Modal title={t('Nouveau client', 'New customer')} onClose={onClose}><form className="lite-form" onSubmit={submit}><label>{t('Nom complet', 'Full name')}<input autoFocus required value={name} onChange={e => setName(e.target.value)} /></label><label>{t('Téléphone WhatsApp', 'WhatsApp phone')}<input required value={phone} onChange={e => setPhone(e.target.value)} placeholder="+225 07 00 00 00 00" /></label><button className="primary wide">{t('Créer le client', 'Create customer')}</button></form></Modal>; }
function Expenses({ data, settings, t, write, reload }) { const [open, setOpen] = useState(false), [form, setForm] = useState({ montant: '', description: '' }); const submit = async e => { e.preventDefault(); const result = await write('/depenses/create', { montant: Number(form.montant), dateDepense: today(), description: form.description }); if (result?.failed) return; setOpen(false); setForm({ montant: '', description: '' }); reload(); }; return <><PageHead eyebrow={t('Sorties', 'Outgoings')} title={t('Dépenses', 'Expenses')} action={<button className="primary" onClick={() => setOpen(true)}>+ {t('Nouvelle dépense', 'New expense')}</button>}><p className="muted">{t('Notez chaque sortie avant de l’oublier.', 'Capture every outgoing before it slips away.')}</p></PageHead><section className="list-card">{data.expenses.slice(0, 12).map(e => <div className="invoice-row" key={e.id}><div><strong>{e.description || t('Dépense', 'Expense')}</strong><small>{dateOf(e.dateDepense)} · {e.statut || t('En attente', 'Pending')}</small></div><b className="debt-amount">− {money(e.montant, settings.currency)}</b></div>)}{!data.expenses.length && <Empty text={t('Aucune dépense enregistrée.', 'No expenses recorded.')} secondary={t('Ajoutez une sortie pour la retrouver ici.', 'Add an outgoing to see it here.')} />}</section>{open && <Modal title={t('Nouvelle dépense', 'New expense')} onClose={() => setOpen(false)}><form className="lite-form" onSubmit={submit}><label>{t('Description', 'Description')}<input autoFocus required value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder={t('Transport, achat, loyer…', 'Transport, supplies, rent…')} /></label><label>{t('Montant', 'Amount')}<input type="number" min="1" required value={form.montant} onChange={e => setForm({ ...form, montant: e.target.value })} /></label><button className="primary wide">{t('Enregistrer', 'Save expense')}</button></form></Modal>}</>; }
function Stock({ data, settings, t, write, reload }) { const [open, setOpen] = useState(false), [adjust, setAdjust] = useState(null), [form, setForm] = useState({ nom: '', prixVente: '', quantite: '', stockMinimum: '2' }); const create = async e => { e.preventDefault(); const result = await write('/produits', { ...form, prixVente: Number(form.prixVente), quantite: Number(form.quantite), stockMinimum: Number(form.stockMinimum) }); if (result?.failed) return; setOpen(false); reload(); }; const doAdjust = async e => { e.preventDefault(); const q = Number(e.target.quantite.value); const result = await write(`/produits/${adjust.id}/ajuster-stock`, { quantite: q, type: q >= 0 ? 'entree' : 'sortie', motif: 'Ajustement Lite' }); if (result?.failed) return; setAdjust(null); reload(); }; return <><PageHead eyebrow={t('Inventaire', 'Inventory')} title={t('Stock', 'Stock')} action={<button className="primary" onClick={() => setOpen(true)}>+ {t('Nouveau produit', 'New product')}</button>}><p className="muted">{t('Voyez ce qui doit être réapprovisionné.', 'See what needs replenishing.')}</p></PageHead><section className="list-card">{data.products.map(p => { const low = Number(p.quantite || 0) <= Number(p.stockMinimum || 0); return <div className={`stock-row ${low ? 'low' : ''}`} key={p.id}><div><strong>{p.nom}</strong><small>{p.reference || t('Sans référence', 'No reference')} · {money(p.prixVente, settings.currency)}</small></div><b>{p.quantite || 0} <small>{p.uniteMesure || 'u.'}</small></b><button className="outline" onClick={() => setAdjust(p)}>{t('Ajuster', 'Adjust')}</button></div>; })}{!data.products.length && <Empty text={t('Ajoutez votre premier produit.', 'Add your first product.')} />}</section>{open && <Modal title={t('Nouveau produit', 'New product')} onClose={() => setOpen(false)}><form className="lite-form" onSubmit={create}><label>{t('Nom', 'Name')}<input autoFocus required value={form.nom} onChange={e => setForm({ ...form, nom: e.target.value })} /></label><div className="form-split"><label>{t('Prix', 'Price')}<input type="number" min="0" value={form.prixVente} onChange={e => setForm({ ...form, prixVente: e.target.value })} /></label><label>{t('Stock initial', 'Initial stock')}<input type="number" min="0" value={form.quantite} onChange={e => setForm({ ...form, quantite: e.target.value })} /></label></div><label>{t('Seuil bas', 'Low threshold')}<input type="number" min="0" value={form.stockMinimum} onChange={e => setForm({ ...form, stockMinimum: e.target.value })} /></label><button className="primary wide">{t('Créer le produit', 'Create product')}</button></form></Modal>}{adjust && <Modal title={`${t('Ajuster', 'Adjust')} · ${adjust.nom}`} onClose={() => setAdjust(null)}><form className="lite-form" onSubmit={doAdjust}><p className="muted">{t('Positif pour une entrée, négatif pour une sortie.', 'Positive adds, negative removes.')}</p><input name="quantite" type="number" autoFocus required placeholder="+10 ou -2" /><button className="primary wide">{t('Appliquer', 'Apply')}</button></form></Modal>}</>; }
function Reports({ data, settings, t }) { const [receipt, setReceipt] = useState(null); const sales = data.invoices.filter(i => dateOf(i.dateFacture) === today()); const report = () => `<html><body style="font-family:Arial;padding:32px"><h1>ComptaOrion Lite</h1><h2>Rapport du ${today()}</h2><p>Ventes: ${money(sales.reduce((s, x) => s + Number(x.totalTTC || 0), 0), settings.currency)}</p><p>Factures: ${sales.length}</p></body></html>`; const print = () => { const w = window.open('', '_blank'); w.document.write(report()); w.document.close(); w.print(); }; const share = async () => { if (navigator.share) await navigator.share({ title: 'Rapport ComptaOrion Lite', text: `Rapport du ${today()}` }); else print(); }; const makePng = () => { const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 600; const c = canvas.getContext('2d'); c.fillStyle = '#f8f2e8'; c.fillRect(0, 0, 900, 600); c.fillStyle = '#172326'; c.font = 'bold 42px sans-serif'; c.fillText('ComptaOrion Lite', 60, 90); c.font = '22px sans-serif'; c.fillText(`Reçu ${receipt.numeroFacture || '#' + receipt.id}`, 60, 145); c.fillText(receipt.client?.nom || 'Client comptant', 60, 205); c.font = 'bold 44px sans-serif'; c.fillText(money(receipt.totalTTC, settings.currency), 60, 330); const a = document.createElement('a'); a.download = 'recu-comptaorion.png'; a.href = canvas.toDataURL('image/png'); a.click(); }; return <><PageHead eyebrow={t('Clarté', 'Clarity')} title={t('Reçus & rapports', 'Receipts & reports')}><p className="muted">{t('Gardez une trace simple, partagez-la partout.', 'Keep a simple record, share it anywhere.')}</p></PageHead><section className="report-hero"><span>{t('Rapport du jour', 'Today’s report')}</span><strong>{money(sales.reduce((s, x) => s + Number(x.totalTTC || 0), 0), settings.currency)}</strong><small>{sales.length} {t('vente(s)', 'sale(s)')}</small><div><button className="primary" onClick={print}>{t('Imprimer / PDF', 'Print / PDF')}</button><button className="outline light" onClick={share}>{t('Partager', 'Share')}</button></div></section><h2 className="subheading">{t('Derniers reçus', 'Recent receipts')}</h2><section className="list-card">{data.invoices.slice(0, 8).map(i => <div className="invoice-row" key={i.id}><div><strong>{i.client?.nom || t('Client comptant', 'Cash customer')}</strong><small>{i.numeroFacture || `#${i.id}`} · {dateOf(i.dateFacture)}</small></div><button className="outline" onClick={() => setReceipt(i)}>{t('Ouvrir', 'Open')}</button></div>)}</section>{receipt && <Modal title={t('Reçu', 'Receipt')} onClose={() => setReceipt(null)}><div className="receipt-preview"><span>ComptaOrion Lite</span><small>{receipt.numeroFacture || `#${receipt.id}`}</small><h3>{money(receipt.totalTTC, settings.currency)}</h3><p>{receipt.client?.nom || t('Client comptant', 'Cash customer')}</p></div><button className="primary wide" onClick={makePng}>{t('Télécharger le PNG', 'Download PNG')}</button></Modal>}</>; }
function Settings({ settings, saveSettings, t, logout, installPrompt }) { const install = async () => { if (!installPrompt) return; await installPrompt.prompt(); await installPrompt.userChoice; }; return <><PageHead eyebrow={t('Votre espace', 'Your space')} title={t('Réglages', 'Settings')}><p className="muted">{t('Lite reste à votre image.', 'Lite works your way.')}</p></PageHead><section className="settings-card"><label>{t('Langue', 'Language')}<select value={settings.language} onChange={e => saveSettings({ ...settings, language: e.target.value })}><option value="fr">Français</option><option value="en">English</option></select></label><label>{t('Devise affichée', 'Displayed currency')}<select value={settings.currency} onChange={e => saveSettings({ ...settings, currency: e.target.value })}><option>FCFA</option><option>EUR</option><option>USD</option></select></label><p className="install-help">{t('Cette devise est une étiquette d’affichage uniquement : aucune conversion monétaire n’est effectuée.', 'This currency is display-only: no currency conversion is performed.')}</p>{installPrompt ? <button className="primary wide" onClick={install}>{t('Installer l’application', 'Install the app')}</button> : <p className="install-help">{window.matchMedia?.('(display-mode: standalone)').matches ? t('Application installée. Vous pouvez travailler plus vite depuis votre écran d’accueil.', 'App installed. You can work faster from your home screen.') : t('Pour installer : ouvrez le menu du navigateur puis “Ajouter à l’écran d’accueil”. Sur iPhone : Partager, puis “Sur l’écran d’accueil”.', 'To install: open your browser menu and choose “Add to Home screen”. On iPhone: Share, then “Add to Home Screen”.')}</p>}</section><section className="settings-links"><a href="/">← {t('Retourner à ComptaOrion ERP', 'Back to full ComptaOrion ERP')}</a><button className="danger-link" onClick={logout}>{t('Se déconnecter', 'Log out')}</button></section></>; }
function LiteReports({ data, settings, t }) {
  const [receipt, setReceipt] = useState(null);
  const sales = data.invoices.filter(i => dateOf(i.dateFacture) === today());
  const total = Number(data.daySummary?.ventes ?? sales.reduce((s, x) => s + Number(x.totalTTC || 0), 0));
  const expenses = data.expenses.filter(x => dateOf(x.dateDepense) === today());
  const expenseTotal = expenses.reduce((s, x) => s + Number(x.montant || 0), 0);
  const received = Number(data.daySummary?.encaissements ?? sales.reduce((s, x) => s + Number(x.montantPaye || 0), 0));
  const printHtml = (item) => `<html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;padding:24px;max-width:720px;margin:auto;color:#172326}h1{font-size:24px}.receipt-line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;padding:10px 0;border-bottom:1px solid #ddd;break-inside:avoid}.receipt-line span{overflow-wrap:anywhere}.receipt-total{text-align:right;margin-top:24px}@media print{body{padding:0}}</style></head><body><h1>ComptaOrion Lite</h1><h2>${escapeHtml(item ? `Reçu ${item.numeroFacture || '#' + item.id}` : `Rapport du ${today()}`)}</h2><p>${escapeHtml(item ? (item.client?.nom || 'Client comptant') : `${sales.length} vente(s)`)}</p>${item ? `${item.items?.map(x => `<div class="receipt-line"><span>${escapeHtml(x.description)}<br><small>${escapeHtml(x.quantite)} × ${escapeHtml(money(x.prixUnitaire, settings.currency))}</small></span><b>${escapeHtml(money(Number(x.quantite) * Number(x.prixUnitaire), settings.currency))}</b></div>`).join('') || ''}<h2 class="receipt-total">${escapeHtml(money(item.totalTTC, settings.currency))}</h2>` : `<p>Ventes: ${escapeHtml(money(total, settings.currency))}</p><p>Dépenses: ${escapeHtml(money(expenseTotal, settings.currency))}</p><p>Encaissements: ${escapeHtml(money(received, settings.currency))}</p><h2>Solde de caisse: ${escapeHtml(money(received - expenseTotal, settings.currency))}</h2>`}</body></html>`;
  const openDetail = async (item) => { if (item.items) return setReceipt(item); try { const result = await api.get(`/factures/${item.id}`); setReceipt(result?.data || result); } catch { setReceipt(item); } };
  const print = (item) => { const w = window.open('', '_blank'); w.document.write(printHtml(item)); w.document.close(); w.print(); };
  const pngBlob = (item) => new Promise(resolve => { const lines = item.items || []; const canvas = document.createElement('canvas'); canvas.width = 900; const c = canvas.getContext('2d'); c.font = '22px system-ui'; const wrap = (text, maxWidth) => { const output = []; let current = ''; for (const word of String(text || '').split(/\s+/)) { if (!word) continue; const parts = c.measureText(word).width <= maxWidth ? [word] : word.match(/.{1,24}/g); for (const part of parts) { const candidate = current ? `${current} ${part}` : part; if (c.measureText(candidate).width > maxWidth && current) { output.push(current); current = part; } else current = candidate; } } if (current) output.push(current); return output.length ? output : ['']; }; const rows = lines.map(line => ({ line, descriptionLines: wrap(line.description, 620) })); const rowsHeight = rows.reduce((sum, row) => sum + row.descriptionLines.length * 28 + 54, 0); canvas.height = Math.max(600, 390 + rowsHeight); c.fillStyle = '#f8f2e8'; c.fillRect(0, 0, canvas.width, canvas.height); c.fillStyle = '#172326'; c.font = 'bold 42px system-ui'; c.fillText('ComptaOrion Lite', 60, 90); c.font = '22px system-ui'; c.fillText(`Reçu ${item.numeroFacture || '#' + item.id}`, 60, 150); c.fillText(item.client?.nom || t('Client comptant', 'Cash customer'), 60, 210); let y = 280; rows.forEach(({ line, descriptionLines }) => { c.font = '22px system-ui'; descriptionLines.forEach(chunk => { c.fillText(chunk, 60, y); y += 28; }); c.font = '18px system-ui'; c.fillStyle = '#56615f'; c.fillText(`${line.quantite} × ${money(line.prixUnitaire, settings.currency)}`, 60, y); c.textAlign = 'right'; c.fillText(money(Number(line.quantite) * Number(line.prixUnitaire), settings.currency), 840, y); c.textAlign = 'left'; c.fillStyle = '#172326'; y += 54; }); c.font = 'bold 38px system-ui'; c.textAlign = 'right'; c.fillText(money(item.totalTTC, settings.currency), 840, canvas.height - 70); canvas.toBlob(resolve, 'image/png'); });
  const shareReport = async () => { const text = `Rapport ComptaOrion Lite du ${today()} — ventes ${money(total, settings.currency)}, dépenses ${money(expenseTotal, settings.currency)}, encaissements ${money(received, settings.currency)}, solde de caisse ${money(received - expenseTotal, settings.currency)}`; if (navigator.share) await navigator.share({ title: 'Rapport ComptaOrion Lite', text }); else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank'); };
  const shareReceipt = async () => { const blob = await pngBlob(receipt); if (!blob) return; const file = new File([blob], 'recu-comptaorion.png', { type: 'image/png' }); if (navigator.share && navigator.canShare?.({ files: [file] })) await navigator.share({ title: 'Reçu ComptaOrion Lite', files: [file] }); else { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } };
  return <><PageHead eyebrow={t('Clarté', 'Clarity')} title={t('Reçus & rapports', 'Receipts & reports')}><p className="muted">{t('Gardez une trace simple, partagez-la partout.', 'Keep a simple record, share it anywhere.')}</p></PageHead><section className="report-hero"><span>{t('Rapport du jour', 'Today’s report')}</span><strong>{money(total, settings.currency)}</strong><small>{sales.length} {t('vente(s)', 'sale(s)')}</small><div><button className="primary" onClick={() => print()}>{t('Imprimer / PDF', 'Print / PDF')}</button><button className="outline light" onClick={shareReport}>{t('Partager', 'Share')}</button></div></section><h2 className="subheading">{t('Derniers reçus', 'Recent receipts')}</h2><section className="list-card">{data.invoices.slice(0, 8).map(i => <div className="invoice-row" key={i.id}><div><strong>{i.client?.nom || t('Client comptant', 'Cash customer')}</strong><small>{i.numeroFacture || `#${i.id}`} · {dateOf(i.dateFacture)}</small></div><button className="outline" onClick={() => openDetail(i)}>{t('Ouvrir', 'Open')}</button></div>)}</section>{receipt && <Modal title={t('Reçu', 'Receipt')} onClose={() => setReceipt(null)}><div className="receipt-preview"><span>ComptaOrion Lite</span><small>{receipt.numeroFacture || `#${receipt.id}`}</small>{receipt.items?.map(x => <p key={x.id || x.description}>{x.description} · {x.quantite} × {money(x.prixUnitaire, settings.currency)}</p>)}<h3>{money(receipt.totalTTC, settings.currency)}</h3><p>{receipt.client?.nom || t('Client comptant', 'Cash customer')}</p></div><div className="form-split"><button className="primary" onClick={shareReceipt}>{t('Partager PNG', 'Share PNG')}</button><button className="outline" onClick={() => print(receipt)}>{t('Imprimer / PDF', 'Print / PDF')}</button></div></Modal>}</>;
}