import { useEffect, useMemo, useState } from 'react';
import api from './api.js';

const today = () => new Date().toISOString().slice(0, 10);
const money = (value, currency) => `${Math.round(Number(value) || 0).toLocaleString('fr-FR')} ${currency}`;

export default function AccountingAccountsPage({ clients = [], invoices = [], settings = {}, t = (fr) => fr, onChanged }) {
  const currency = settings.currency || 'FCFA';
  const [section, setSection] = useState('clients');
  const [suppliers, setSuppliers] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [banks, setBanks] = useState([]);
  const [checks, setChecks] = useState([]);
  const [selectedThirdParty, setSelectedThirdParty] = useState('');
  const [ledger, setLedger] = useState(null);
  const [selectedInvoice, setSelectedInvoice] = useState('');
  const [returnItems, setReturnItems] = useState([]);
  const [restock, setRestock] = useState({});
  const [dateRetour, setDateRetour] = useState(today());
  const [returnMessage, setReturnMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [depositBank, setDepositBank] = useState({});
  const [paymentInvoice, setPaymentInvoice] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMode, setPaymentMode] = useState('virement');
  const [paymentMessage, setPaymentMessage] = useState('');
  const [clientPaymentInvoice, setClientPaymentInvoice] = useState('');
  const [clientPaymentAmount, setClientPaymentAmount] = useState('');
  const [clientPaymentMode, setClientPaymentMode] = useState('mobile_money');
  const [clientChequeNumber, setClientChequeNumber] = useState('');
  const [clientChequeBank, setClientChequeBank] = useState('');
  const [clientPaymentMessage, setClientPaymentMessage] = useState('');

  const loadSupport = async () => {
    try {
      const [suppliersResult, purchasesResult, banksResult, checksResult] = await Promise.all([
        api.get('/fournisseurs'),
        api.get('/achats'),
        api.get('/comptes-bancaires-lite'),
        api.get('/cheques-clients'),
      ]);
      setSuppliers(suppliersResult.data || []);
      setPurchases(purchasesResult.data || []);
      setBanks(banksResult.data || []);
      setChecks(checksResult.data || []);
    } catch (error) {
      setReturnMessage(error.message || t('Impossible de charger les données comptables.', 'Accounting data could not be loaded.'));
    }
  };

  useEffect(() => { loadSupport(); }, []);

  const returnInvoices = section === 'clients' ? invoices : purchases;
  const selectedSourceInvoice = returnInvoices.find((item) => String(item.id) === String(selectedInvoice));
  const selectedPaymentInvoice = purchases.find((item) => String(item.id) === String(paymentInvoice));
  const selectedClientPaymentInvoice = invoices.find((item) => String(item.id) === String(clientPaymentInvoice));

  useEffect(() => {
    let active = true;
    setReturnItems([]);
    setRestock({});
    if (!selectedSourceInvoice) return undefined;
    if (section === 'suppliers') {
      const items = selectedSourceInvoice.items || [];
      setReturnItems(items);
      return () => { active = false; };
    }
    api.get(`/factures/${selectedSourceInvoice.id}`).then((result) => {
      if (!active) return;
      setReturnItems(result.data?.items || []);
    }).catch((error) => {
      if (active) setReturnMessage(error.message || t('Impossible de charger les articles de la facture.', 'Invoice items could not be loaded.'));
    });
    return () => { active = false; };
  }, [selectedSourceInvoice?.id, section]);

  useEffect(() => {
    let active = true;
    setLedger(null);
    if (!selectedThirdParty) return undefined;
    const endpoint = section === 'clients'
      ? `/clients/${selectedThirdParty}/compte`
      : `/fournisseurs/${selectedThirdParty}/compte`;
    api.get(endpoint).then((result) => { if (active) setLedger(result.data); })
      .catch((error) => { if (active) setReturnMessage(error.message || t('Relevé indisponible.', 'Statement unavailable.')); });
    return () => { active = false; };
  }, [selectedThirdParty, section]);

  const thirdParties = section === 'clients' ? clients : suppliers;
  const thirdPartyId = (item) => item.id;
  const thirdPartyName = (item) => section === 'clients' ? item.nom : item.raisonSociale;
  const invoiceLabel = (item) => `${item.numeroFacture || `#${item.id}`} · ${money(item.soldeRestant, currency)}`;

  const createReturn = async (event) => {
    event.preventDefault();
    setReturnMessage('');
    const selected = returnItems
      .map((item) => ({
        itemId: Number(item.id),
        quantite: Number(item.returnQuantity || 0),
        ...(section === 'clients' ? { reintegrerStock: restock[item.id] === true } : {}),
      }))
      .filter((item) => item.quantite > 0);
    if (!selectedInvoice || !selected.length) {
      setReturnMessage(t('Choisissez une facture et une quantité à retourner.', 'Choose an invoice and a quantity to return.'));
      return;
    }
    setBusy(true);
    try {
      const path = section === 'clients' ? `/factures/${selectedInvoice}/retours` : `/achats/${selectedInvoice}/retours`;
      const result = await api.post(path, { dateRetour, items: selected });
      setReturnMessage(`${result.data?.numero || ''} · ${t('Note créée et comptes mis à jour.', 'Note created and accounts updated.')}`);
      setSelectedInvoice('');
      setSelectedThirdParty(section === 'clients' ? selectedThirdParty : selectedThirdParty);
      await loadSupport();
      onChanged?.();
    } catch (error) {
      setReturnMessage(error.message || t('Le retour n’a pas été enregistré.', 'The return was not recorded.'));
    } finally {
      setBusy(false);
    }
  };

  const postSupplierPayment = async (event) => {
    event.preventDefault();
    setPaymentMessage('');
    if (!selectedPaymentInvoice || Number(paymentAmount) <= 0) return;
    setBusy(true);
    try {
      const result = await api.post(`/achats/${paymentInvoice}/paiement`, {
        montant: Number(paymentAmount),
        modePaiement: paymentMode,
        datePaiement: today(),
      });
      setPaymentMessage(t('Règlement fournisseur enregistré et comptabilisé.', 'Supplier payment recorded and posted.'));
      setPaymentAmount('');
      setPaymentInvoice('');
      await loadSupport();
      onChanged?.();
    } catch (error) {
      setPaymentMessage(error.message || t('Le règlement n’a pas été enregistré.', 'The payment was not recorded.'));
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
      await api.post(`/factures/${clientPaymentInvoice}/paiement`, {
        montant: Number(clientPaymentAmount),
        modePaiement: clientPaymentMode,
        datePaiement: today(),
        ...(clientPaymentMode === 'cheque' ? {
          numeroCheque: clientChequeNumber,
          banqueCheque: clientChequeBank,
        } : {}),
      });
      setClientPaymentMessage(t('Paiement enregistré : le compte client est crédité immédiatement.', 'Payment recorded: the customer account is credited immediately.'));
      setClientPaymentAmount('');
      setClientChequeNumber('');
      setClientChequeBank('');
      setClientPaymentInvoice('');
      await loadSupport();
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
      <div><span className="eyebrow">{t('Suivi des tiers', 'Third-party accounts')}</span><h1>{t('Comptes clients et fournisseurs', 'Customer and supplier accounts')}</h1>
        <p className="muted">{t('Consultez les débits, crédits, retours et chèques reçus.', 'Review debits, credits, returns, and received checks.')}</p>
      </div>
    </div>
    <div className="purchase-tabs" role="tablist">
      {['clients', 'suppliers', 'checks'].map((key) => <button key={key} role="tab" aria-selected={section === key} className={section === key ? 'selected' : ''} onClick={() => { setSection(key); setSelectedThirdParty(''); setSelectedInvoice(''); }}>
        {key === 'clients' ? t('Clients', 'Customers') : key === 'suppliers' ? t('Fournisseurs', 'Suppliers') : t('Chèques à déposer', 'Checks to deposit')}
      </button>)}
    </div>

    {section !== 'checks' ? <>
      <section className="list-card" style={{ marginTop: 16 }}>
        <label>{section === 'clients' ? t('Compte client', 'Customer account') : t('Compte fournisseur', 'Supplier account')}
          <select value={selectedThirdParty} onChange={(event) => setSelectedThirdParty(event.target.value)}>
            <option value="">{t('Choisir un compte', 'Choose an account')}</option>
            {thirdParties.map((item) => <option key={thirdPartyId(item)} value={thirdPartyId(item)}>{thirdPartyName(item)}</option>)}
          </select>
        </label>
        {ledger && <><div className="metric-grid" style={{ marginTop: 16 }}>
          <div className="metric-card ink"><span>{t('Factures', 'Invoices')}</span><strong>{money(ledger.totaux.factures, currency)}</strong></div>
          <div className="metric-card mint"><span>{section === 'clients' ? t('Paiements reçus', 'Payments received') : t('Paiements effectués', 'Payments made')}</span><strong>{money(ledger.totaux.paiements, currency)}</strong></div>
          <div className="metric-card sand"><span>{section === 'clients' ? t('Avoirs sur retours', 'Return credits') : t('Retours fournisseurs', 'Supplier returns')}</span><strong>{money(ledger.totaux.retours, currency)}</strong></div>
          <div className="metric-card ink"><span>{section === 'clients' ? t('Solde à recevoir', 'Balance to collect') : t('Solde à payer', 'Balance payable')}</span><strong>{money(Math.abs(ledger.totaux.solde), currency)}{ledger.totaux.solde < 0 ? ` · ${t('solde créditeur', 'credit balance')}` : ''}</strong></div>
        </div>{section === 'clients' && <p className="muted" style={{ marginTop: 12 }}>{t('Un paiement réduit le solde; un avoir est créé séparément lors d’un retour de marchandise.', 'A payment reduces the balance; a credit note is recorded separately through a goods return.')}</p>}<div className="activity" style={{ marginTop: 16 }}>
          <div className="section-title"><h2>{t('Mouvements du compte', 'Account movements')}</h2></div>
          {movementRows.length ? movementRows.map((row, index) => <div className="activity-row" key={`${row.reference}-${index}`}>
            <span>{String(row.date || '').slice(0, 10)}</span><div><strong>{row.libelle}</strong><small>{row.reference}</small></div>
            <span className={`status ${row.type}`}>{row.type === 'paiement' ? t('Paiement', 'Payment') : row.type === 'retour' ? (section === 'clients' ? t('Avoir sur retour', 'Return credit') : t('Retour fournisseur', 'Supplier return')) : t('Facture', 'Invoice')}</span>
            <b>{money(row.montant, currency)}</b>
          </div>) : <p className="muted">{t('Aucun mouvement enregistré.', 'No account movements recorded.')}</p>}
        </div></>}
      </section>

      <section className="list-card" style={{ marginTop: 16 }}>
        <h2>{section === 'clients' ? t('Créer un avoir via un retour de marchandise', 'Create a credit note through a goods return') : t('Enregistrer un retour fournisseur', 'Record a supplier return')}</h2>
        <form className="lite-form" onSubmit={createReturn}>
          <label>{t('Facture d’origine', 'Source invoice')}
            <select value={selectedInvoice} onChange={(event) => setSelectedInvoice(event.target.value)} required>
              <option value="">{t('Choisir une facture', 'Choose an invoice')}</option>
              {returnInvoices.filter((item) => !selectedThirdParty || Number(section === 'clients' ? item.clientId : item.fournisseur?.id) === Number(selectedThirdParty))
                .map((item) => <option key={item.id} value={item.id}>{invoiceLabel(item)}</option>)}
            </select>
          </label>
          <label>{t('Date du retour', 'Return date')}<input type="date" value={dateRetour} onChange={(event) => setDateRetour(event.target.value)} required /></label>
          {returnItems.map((item) => <fieldset className="sale-item" key={item.id}>
            <strong>{item.description}</strong>
            <small>{t('Quantité d’origine', 'Original quantity')}: {item.quantite} · {money(item.prixUnitaire, currency)} / {t('unité', 'unit')}</small>
            <label>{t('Quantité retournée', 'Returned quantity')}
              <input type="number" min="0" max={item.quantite} step="0.001" value={item.returnQuantity || ''} onChange={(event) => setReturnItems((current) => current.map((row) => row.id === item.id ? { ...row, returnQuantity: event.target.value } : row))} />
            </label>
            {section === 'clients' && item.produitId && <label className="check-row">
              <input type="checkbox" checked={restock[item.id] === true} onChange={(event) => setRestock((current) => ({ ...current, [item.id]: event.target.checked }))} />
              {t('Article revendable : réintégrer au stock', 'Resalable item: return to stock')}
            </label>}
          </fieldset>)}
          {returnMessage && <p role="status" className="muted">{returnMessage}</p>}
          <button className="primary" type="submit" disabled={busy || !selectedInvoice}>{t('Créer la note et les écritures', 'Create note and journal entries')}</button>
        </form>
      </section>

      {section === 'suppliers' && <section className="list-card" style={{ marginTop: 16 }}>
        <h2>{t('Régler une facture fournisseur', 'Pay a supplier invoice')}</h2>
        <form className="lite-form" onSubmit={postSupplierPayment}>
          <label>{t('Facture à régler', 'Invoice to pay')}<select value={paymentInvoice} onChange={(event) => setPaymentInvoice(event.target.value)} required>
            <option value="">{t('Choisir une facture', 'Choose an invoice')}</option>
            {purchases.filter((item) => Number(item.soldeRestant) > 0).map((item) => <option key={item.id} value={item.id}>{item.fournisseur?.raisonSociale} · {invoiceLabel(item)}</option>)}
          </select></label>
          {selectedPaymentInvoice && <label>{t('Montant', 'Amount')}<input type="number" min="0.01" max={selectedPaymentInvoice.soldeRestant} step="0.01" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} required /></label>}
          <label>{t('Mode de règlement', 'Payment method')}<select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)}><option value="virement">{t('Virement bancaire', 'Bank transfer')}</option><option value="especes">{t('Espèces', 'Cash')}</option><option value="mobile_money">{t('Mobile money', 'Mobile money')}</option></select></label>
          {paymentMessage && <p role="status" className="muted">{paymentMessage}</p>}
          <button className="primary" type="submit" disabled={busy}>{t('Enregistrer le règlement', 'Record payment')}</button>
        </form>
      </section>}
      {section === 'clients' && <section className="list-card" style={{ marginTop: 16 }}>
        <h2>{t('Encaisser un paiement client', 'Record a customer payment')}</h2>
        <form className="lite-form" onSubmit={postClientPayment}>
          <label>{t('Facture à régler', 'Invoice to pay')}<select value={clientPaymentInvoice} onChange={(event) => setClientPaymentInvoice(event.target.value)} required>
            <option value="">{t('Choisir une facture', 'Choose an invoice')}</option>
            {invoices.filter((item) => Number(item.soldeRestant) > 0).map((item) => <option key={item.id} value={item.id}>{item.client?.nom} · {invoiceLabel(item)}</option>)}
          </select></label>
          {selectedClientPaymentInvoice && <label>{t('Montant reçu', 'Amount received')}<input type="number" min="0.01" max={selectedClientPaymentInvoice.soldeRestant} step="0.01" value={clientPaymentAmount} onChange={(event) => setClientPaymentAmount(event.target.value)} required /></label>}
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
      </section>}
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
