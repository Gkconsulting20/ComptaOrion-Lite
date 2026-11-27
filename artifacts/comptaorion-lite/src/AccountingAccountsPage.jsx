import { useEffect, useMemo, useState } from 'react';
import api from './api.js';

const today = () => new Date().toISOString().slice(0, 10);
const money = (value, currency) => `${Math.round(Number(value) || 0).toLocaleString('fr-FR')} ${currency}`;

function quoteDiscount(invoice, party) {
  const rate = Number(party?.escomptePourcentage || 0);
  const days = Number(party?.escompteDelaiJours || 0);
  const balance = Number(invoice?.soldeRestant || 0);
  const invoiceDate = String(invoice?.dateFacture || '').slice(0, 10);
  if (!rate || !days || balance <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) return null;
  const start = new Date(`${invoiceDate}T00:00:00.000Z`);
  const cutoff = new Date(start.getTime() + days * 86400000);
  const now = new Date(`${today()}T00:00:00.000Z`);
  if (now < start || now > cutoff) return null;
  const discount = Math.round((balance * rate / 100 + Number.EPSILON) * 100) / 100;
  if (discount <= 0 || discount >= balance) return null;
  return { rate, days, discount, net: Math.round((balance - discount + Number.EPSILON) * 100) / 100, cutoff: cutoff.toISOString().slice(0, 10) };
}

// Comptes tiers — clients uniquement (Lite services uniquement) : la
// section fournisseurs, les retours de marchandises et les règlements
// fournisseurs sont retirés avec les achats. Restent : le relevé client
// (les avoirs historiques de retours restent lisibles), la note de débit
// client (avoir sur prestation, sans stock), les conditions d'escompte,
// l'encaissement client et les chèques à déposer.
export default function AccountingAccountsPage({ clients = [], invoices = [], settings = {}, t = (fr) => fr, onChanged }) {
  const currency = settings.currency || 'FCFA';
  const [section, setSection] = useState('clients');
  const [banks, setBanks] = useState([]);
  const [checks, setChecks] = useState([]);
  const [selectedThirdParty, setSelectedThirdParty] = useState('');
  const [ledger, setLedger] = useState(null);
  const [returnMessage, setReturnMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [depositBank, setDepositBank] = useState({});
  const [clientPaymentInvoice, setClientPaymentInvoice] = useState('');
  const [clientPaymentAmount, setClientPaymentAmount] = useState('');
  const [clientPaymentMode, setClientPaymentMode] = useState('mobile_money');
  const [clientChequeNumber, setClientChequeNumber] = useState('');
  const [clientChequeBank, setClientChequeBank] = useState('');
  const [clientPaymentMessage, setClientPaymentMessage] = useState('');
  const [discountRate, setDiscountRate] = useState('0');
  const [discountDays, setDiscountDays] = useState('0');
  const [netDays, setNetDays] = useState('30');
  const [discountTermsMessage, setDiscountTermsMessage] = useState('');
  const [adjustmentAccounts, setAdjustmentAccounts] = useState([]);
  const [adjustmentInvoice, setAdjustmentInvoice] = useState('');
  const [adjustmentHT, setAdjustmentHT] = useState('');
  const [adjustmentVAT, setAdjustmentVAT] = useState('0');
  const [adjustmentAccountId, setAdjustmentAccountId] = useState('');
  const [adjustmentDate, setAdjustmentDate] = useState(today());
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [adjustmentMessage, setAdjustmentMessage] = useState('');
  const [ledgerRefresh, setLedgerRefresh] = useState(0);

  const loadSupport = async () => {
    try {
      const [banksResult, checksResult] = await Promise.all([
        api.get('/comptes-bancaires-lite'),
        api.get('/cheques-clients'),
      ]);
      setBanks(banksResult.data || []);
      setChecks(checksResult.data || []);
    } catch (error) {
      setReturnMessage(error.message || t('Impossible de charger les données comptables.', 'Accounting data could not be loaded.'));
    }
  };

  useEffect(() => { loadSupport(); }, []);

  const selectedClientPaymentInvoice = invoices.find((item) => String(item.id) === String(clientPaymentInvoice));

  useEffect(() => {
    let active = true;
    setLedger(null);
    if (!selectedThirdParty) return undefined;
    api.get(`/clients/${selectedThirdParty}/compte`).then((result) => { if (active) setLedger(result.data); })
      .catch((error) => { if (active) setReturnMessage(error.message || t('Relevé indisponible.', 'Statement unavailable.')); });
    return () => { active = false; };
  }, [selectedThirdParty, section, ledgerRefresh]);

  const thirdParties = clients;
  const selectedThirdPartyRecord = thirdParties.find((item) => String(item.id) === String(selectedThirdParty));
  const thirdPartyId = (item) => item.id;
  const thirdPartyName = (item) => item.nom;
  const invoiceLabel = (item) => `${item.numeroFacture || `#${item.id}`} · ${money(item.soldeRestant, currency)}`;
  const adjustmentInvoices = invoices;
  const selectedAdjustmentInvoice = adjustmentInvoices.find((item) => String(item.id) === String(adjustmentInvoice));
  const selectedClientParty = clients.find((item) => String(item.id) === String(selectedClientPaymentInvoice?.clientId))
    || selectedClientPaymentInvoice?.client;
  const clientDiscountQuote = quoteDiscount(selectedClientPaymentInvoice, selectedClientParty);

  useEffect(() => {
    let active = true;
    setAdjustmentAccounts([]);
    if (section === 'checks') return undefined;
    api.get('/comptes-comptables-ajustement?type=client').then((result) => {
      if (!active) return;
      const accounts = result.data || [];
      setAdjustmentAccounts(accounts);
      setAdjustmentAccountId(String(accounts.find((account) => account.numero === '708')?.id || accounts[0]?.id || ''));
    }).catch((error) => {
      if (active) setAdjustmentMessage(error.message || 'Comptes d’ajustement indisponibles.');
    });
    return () => { active = false; };
  }, [section]);

  useEffect(() => {
    setDiscountRate(String(selectedThirdPartyRecord?.escomptePourcentage || 0));
    setDiscountDays(String(selectedThirdPartyRecord?.escompteDelaiJours || 0));
    setNetDays(String(selectedThirdPartyRecord?.delaiPaiement || 30));
    setDiscountTermsMessage('');
  }, [selectedThirdPartyRecord?.id, section]);

  const saveDiscountTerms = async (event) => {
    event.preventDefault();
    if (!selectedThirdPartyRecord) return;
    setDiscountTermsMessage('');
    setBusy(true);
    try {
      await api.put(`/clients/${selectedThirdPartyRecord.id}/conditions-escompte`, {
        escomptePourcentage: Number(discountRate),
        escompteDelaiJours: Number(discountDays),
        delaiPaiement: Number(netDays),
      });
      setDiscountTermsMessage(t('Conditions de paiement enregistrées.', 'Payment terms saved.'));
      await loadSupport();
      setLedgerRefresh((value) => value + 1);
      onChanged?.();
    } catch (error) {
      setDiscountTermsMessage(error.message || t('Les conditions n’ont pas été enregistrées.', 'Payment terms were not saved.'));
    } finally {
      setBusy(false);
    }
  };

  const createAdjustment = async (event) => {
    event.preventDefault();
    if (!selectedAdjustmentInvoice || !selectedThirdPartyRecord) return;
    setAdjustmentMessage('');
    setBusy(true);
    try {
      const result = await api.post(`/factures/${adjustmentInvoice}/notes-debit`, {
        dateNote: adjustmentDate,
        totalHT: Number(adjustmentHT),
        totalTVA: Number(adjustmentVAT || 0),
        compteAjustementId: Number(adjustmentAccountId),
        motif: adjustmentReason,
      });
      setAdjustmentMessage(`${result.data?.note?.numero || ''} · ${t('Note créée, sans mouvement de stock.', 'Note created, no stock movement.')}`);
      setAdjustmentHT('');
      setAdjustmentVAT('0');
      setAdjustmentReason('');
      setAdjustmentInvoice('');
      await loadSupport();
      setLedgerRefresh((value) => value + 1);
      onChanged?.();
    } catch (error) {
      setAdjustmentMessage(error.message || t('La note d’ajustement n’a pas été créée.', 'The adjustment note was not created.'));
    } finally {
      setBusy(false);
    }
  };

  const postClientPayment = async (event) => {
    event.preventDefault();
    setClientPaymentMessage('');
    if (!selectedClientPaymentInvoice || Number(clientPaymentAmount) <= 0) return;
    setBusy(true);
    try {
      const result = await api.post(`/factures/${clientPaymentInvoice}/paiement`, {
        montant: Number(clientPaymentAmount),
        modePaiement: clientPaymentMode,
        datePaiement: today(),
        ...(clientPaymentMode === 'cheque' ? {
          numeroCheque: clientChequeNumber,
          banqueCheque: clientChequeBank,
        } : {}),
      });
      setClientPaymentMessage(Number(result.data?.escompteMontant) > 0
        ? `${t('Paiement enregistré. Escompte accordé :', 'Payment recorded. Discount granted:')} ${money(result.data.escompteMontant, currency)}.`
        : t('Paiement enregistré : le compte client est crédité immédiatement.', 'Payment recorded: the customer account is credited immediately.'));
      setClientPaymentAmount('');
      setClientChequeNumber('');
      setClientChequeBank('');
      setClientPaymentInvoice('');
      await loadSupport();
      setLedgerRefresh((value) => value + 1);
      onChanged?.();
    } catch (error) {
      setClientPaymentMessage(error.message || t('Le paiement n’a pas été enregistré.', 'The payment was not recorded.'));
    } finally {
      setBusy(false);
    }
  };

  const depositCheck = async (paymentId) => {
    const compteBancaireId = Number(depositBank[paymentId]);
    if (!compteBancaireId) {
      setReturnMessage(t('Choisissez le compte bancaire de dépôt.', 'Choose the bank account for the deposit.'));
      return;
    }
    setBusy(true);
    try {
      await api.post(`/cheques-clients/${paymentId}/depot`, { compteBancaireId, dateDepot: today() });
      setReturnMessage(t('Dépôt enregistré en banque; le compte client n’a pas été modifié une seconde fois.', 'Deposit posted to the bank; the customer account was not credited twice.'));
      await loadSupport();
    } catch (error) {
      setReturnMessage(error.message || t('Le dépôt n’a pas été enregistré.', 'The deposit was not recorded.'));
    } finally {
      setBusy(false);
    }
  };

  const movementRows = useMemo(() => ledger?.mouvements || [], [ledger]);

  return <div className="lite-page">
    <div className="lite-page-head">
      <div><span className="eyebrow">{t('Suivi des tiers', 'Third-party accounts')}</span><h1>{t('Comptes clients', 'Customer accounts')}</h1>
        <p className="muted">{t('Suivez paiements, notes d’ajustement, escomptes et chèques reçus.', 'Track payments, adjustment notes, discounts, and received checks.')}</p>
      </div>
    </div>
    <div className="purchase-tabs" role="tablist">
      {['clients', 'checks'].map((key) => <button key={key} role="tab" aria-selected={section === key} className={section === key ? 'selected' : ''} onClick={() => { setSection(key); setSelectedThirdParty(''); }}>
        {key === 'clients' ? t('Clients', 'Customers') : t('Chèques à déposer', 'Checks to deposit')}
      </button>)}
    </div>

    {section !== 'checks' ? <>
      <section className="list-card" style={{ marginTop: 16 }}>
        <label>{t('Compte client', 'Customer account')}
          <select value={selectedThirdParty} onChange={(event) => setSelectedThirdParty(event.target.value)}>
            <option value="">{t('Choisir un compte', 'Choose an account')}</option>
            {thirdParties.map((item) => <option key={thirdPartyId(item)} value={thirdPartyId(item)}>{thirdPartyName(item)}</option>)}
          </select>
        </label>
        {selectedThirdPartyRecord && <form className="lite-form" onSubmit={saveDiscountTerms} style={{ marginTop: 16 }}>
          <div className="section-title"><h2>{t('Conditions de paiement et escompte', 'Payment terms and cash discount')}</h2></div>
          <p className="muted">{t('L’escompte est accordé uniquement si le solde entier est réglé dans le délai indiqué.', 'The discount applies only when the full remaining balance is paid within the stated period.')}</p>
          <div className="form-grid">
            <label>{t('Escompte (%)', 'Discount (%)')}<input type="number" min="0" max="100" step="0.01" value={discountRate} onChange={(event) => setDiscountRate(event.target.value)} required /></label>
            <label>{t('Délai escompte (jours)', 'Discount period (days)')}<input type="number" min="0" max="366" step="1" value={discountDays} onChange={(event) => setDiscountDays(event.target.value)} required /></label>
            <label>{t('Délai net (jours)', 'Net due period (days)')}<input type="number" min="0" max="3660" step="1" value={netDays} onChange={(event) => setNetDays(event.target.value)} required /></label>
          </div>
          {discountTermsMessage && <p role="status" className="muted">{discountTermsMessage}</p>}
          <button className="outline" type="submit" disabled={busy}>{t('Enregistrer les conditions', 'Save terms')}</button>
        </form>}
        {ledger && <><div className="metric-grid" style={{ marginTop: 16 }}>
          <div className="metric-card ink"><span>{t('Factures', 'Invoices')}</span><strong>{money(ledger.totaux.factures, currency)}</strong></div>
          <div className="metric-card mint"><span>{t('Paiements reçus', 'Payments received')}</span><strong>{money(ledger.totaux.paiements, currency)}</strong></div>
          <div className="metric-card sand"><span>{t('Avoirs (historique)', 'Credits (history)')}</span><strong>{money(ledger.totaux.retours, currency)}</strong></div>
          <div className="metric-card sand"><span>{t('Notes de débit', 'Debit notes')}</span><strong>{money(ledger.totaux.notesDebit, currency)}</strong></div>
          <div className="metric-card mint"><span>{t('Escomptes', 'Discounts')}</span><strong>{money(ledger.totaux.escomptes, currency)}</strong></div>
          <div className="metric-card ink"><span>{t('Solde à recevoir', 'Balance to collect')}</span><strong>{money(Math.abs(ledger.totaux.solde), currency)}{ledger.totaux.solde < 0 ? ` · ${t('solde créditeur', 'credit balance')}` : ''}</strong></div>
        </div><p className="muted" style={{ marginTop: 12 }}>{t('Le paiement est distinct d’un avoir. Un avoir sur prestation se fait par note de débit ; l’escompte apparaît séparément.', 'A payment is distinct from a credit note. A credit on a service is made with a debit note; discounts are shown separately.')}</p><div className="activity" style={{ marginTop: 16 }}>
          <div className="section-title"><h2>{t('Mouvements du compte', 'Account movements')}</h2></div>
          {movementRows.length ? movementRows.map((row, index) => <div className="activity-row" key={`${row.reference}-${index}`}>
            <span>{String(row.date || '').slice(0, 10)}</span><div><strong>{row.libelle}</strong><small>{row.reference}</small></div>
            <span className={`status ${row.type}`}>{row.type === 'paiement' ? t('Paiement', 'Payment')
              : row.type === 'retour' ? t('Avoir (historique)', 'Credit (history)')
                : row.type === 'note_debit' ? t('Note de débit', 'Debit note')
                  : row.type === 'note_credit' ? t('Note de crédit', 'Credit note')
                    : row.type === 'escompte' ? t('Escompte', 'Discount')
                      : t('Facture', 'Invoice')}</span>
            <b>{money(row.montant, currency)}</b>
          </div>) : <p className="muted">{t('Aucun mouvement enregistré.', 'No account movements recorded.')}</p>}
        </div></>}
      </section>

      {selectedThirdPartyRecord && <section className="list-card" style={{ marginTop: 16 }}>
        <h2>{t('Note de débit client — ajustement sans retour', 'Customer debit note — adjustment without return')}</h2>
        <p className="muted">{t('Cette note augmente le montant dû par le client. Elle ne modifie pas le stock.', 'This note increases the customer balance and does not change stock.')}</p>
        <form className="lite-form" onSubmit={createAdjustment}>
          <label>{t('Facture d’origine', 'Source invoice')}
            <select value={adjustmentInvoice} onChange={(event) => setAdjustmentInvoice(event.target.value)} required>
              <option value="">{t('Choisir une facture', 'Choose an invoice')}</option>
              {adjustmentInvoices.filter((item) => Number(item.clientId) === Number(selectedThirdParty))
                .map((item) => <option key={item.id} value={item.id}>{invoiceLabel(item)}</option>)}
            </select>
          </label>
          <label>{t('Date de la note', 'Note date')}<input type="date" value={adjustmentDate} onChange={(event) => setAdjustmentDate(event.target.value)} required /></label>
          <label>{t('Montant hors taxes', 'Amount before tax')}<input type="number" min="0.01" step="0.01" value={adjustmentHT} onChange={(event) => setAdjustmentHT(event.target.value)} required /></label>
          <label>{t('TVA', 'VAT')}<input type="number" min="0" step="0.01" value={adjustmentVAT} onChange={(event) => setAdjustmentVAT(event.target.value)} required /></label>
          <label>{t('Compte d’ajustement', 'Adjustment account')}
            <select value={adjustmentAccountId} onChange={(event) => setAdjustmentAccountId(event.target.value)} required>
              <option value="">{t('Choisir un compte', 'Choose an account')}</option>
              {adjustmentAccounts.map((account) => <option key={account.id} value={account.id}>{account.numero} · {account.nom}</option>)}
            </select>
          </label>
          <label>{t('Motif', 'Reason')}<input maxLength="500" value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)} required /></label>
          {(Number(adjustmentHT) > 0) && <p className="muted">{t('Total TTC', 'Total including tax')}: {money(Number(adjustmentHT) + Number(adjustmentVAT || 0), currency)}</p>}
          {adjustmentMessage && <p role="status" className="muted">{adjustmentMessage}</p>}
          <button className="primary" type="submit" disabled={busy || !adjustmentInvoice || !adjustmentAccountId}>{t('Créer la note et l’écriture', 'Create note and journal entry')}</button>
        </form>
      </section>}

      <section className="list-card" style={{ marginTop: 16 }}>
        <h2>{t('Encaisser un paiement client', 'Record a customer payment')}</h2>
        <form className="lite-form" onSubmit={postClientPayment}>
          <label>{t('Facture à régler', 'Invoice to pay')}<select value={clientPaymentInvoice} onChange={(event) => setClientPaymentInvoice(event.target.value)} required>
            <option value="">{t('Choisir une facture', 'Choose an invoice')}</option>
            {invoices.filter((item) => Number(item.soldeRestant) > 0).map((item) => <option key={item.id} value={item.id}>{item.client?.nom} · {invoiceLabel(item)}</option>)}
          </select></label>
          {selectedClientPaymentInvoice && <label>{t('Montant reçu', 'Amount received')}<input type="number" min="0.01" max={selectedClientPaymentInvoice.soldeRestant} step="0.01" value={clientPaymentAmount} onChange={(event) => setClientPaymentAmount(event.target.value)} required /></label>}
          {selectedClientPaymentInvoice && clientDiscountQuote && <p className="muted">
            {t(`Escompte ${clientDiscountQuote.rate}% si le solde entier est payé avant le ${clientDiscountQuote.cutoff} :`, `Discount ${clientDiscountQuote.rate}% if the full balance is paid by ${clientDiscountQuote.cutoff}:`)} {money(clientDiscountQuote.discount, currency)} · {t('paiement net', 'net payment')} {money(clientDiscountQuote.net, currency)}.
            <button type="button" className="outline" style={{ marginLeft: 8 }} onClick={() => setClientPaymentAmount(clientDiscountQuote.net.toFixed(2))}>{t('Utiliser ce montant', 'Use this amount')}</button>
          </p>}
          <label>{t('Mode de paiement', 'Payment method')}<select value={clientPaymentMode} onChange={(event) => setClientPaymentMode(event.target.value)}>
            <option value="mobile_money">{t('Mobile money', 'Mobile money')}</option><option value="especes">{t('Espèces', 'Cash')}</option><option value="virement">{t('Virement', 'Bank transfer')}</option><option value="cheque">{t('Chèque reçu', 'Received check')}</option>
          </select></label>
          {clientPaymentMode === 'cheque' && <>
            <label>{t('Numéro du chèque', 'Cheque number')}<input required value={clientChequeNumber} onChange={(event) => setClientChequeNumber(event.target.value)} /></label>
            <label>{t('Banque émettrice', 'Issuing bank')}<input value={clientChequeBank} onChange={(event) => setClientChequeBank(event.target.value)} /></label>
            <p className="muted">{t('Le compte client sera crédité dès réception. Le dépôt bancaire se suit séparément.', 'The customer account is credited when received. The bank deposit is tracked separately.')}</p>
          </>}
          {clientPaymentMessage && <p role="status" className="muted">{clientPaymentMessage}</p>}
          <button className="primary" type="submit" disabled={busy}>{t('Enregistrer le paiement', 'Record payment')}</button>
        </form>
      </section>
    </> : <section className="list-card" style={{ marginTop: 16 }}>
      <h2>{t('Chèques reçus', 'Received checks')}</h2>
      {checks.length ? checks.map(({ paiement, client, facture }) => <div className="activity-row" key={paiement.id}>
        <div><strong>{client?.nom || t('Client', 'Customer')} · {money(paiement.montant, currency)}</strong><small>{paiement.numeroCheque} · {facture?.numeroFacture || ''} · {paiement.datePaiement}</small></div>
        <select aria-label={t('Compte bancaire de dépôt', 'Deposit bank account')} value={depositBank[paiement.id] || ''} onChange={(event) => setDepositBank((current) => ({ ...current, [paiement.id]: event.target.value }))}>
          <option value="">{t('Choisir la banque', 'Choose bank')}</option>
          {banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.nomCompte}{bank.banque ? ` · ${bank.banque}` : ''}</option>)}
        </select>
        <button className="outline" disabled={busy} onClick={() => depositCheck(paiement.id)}>{t('Enregistrer le dépôt', 'Record deposit')}</button>
      </div>) : <p className="muted">{t('Aucun chèque reçu en attente de dépôt.', 'No received checks awaiting deposit.')}</p>}
    </section>}
  </div>;
}
