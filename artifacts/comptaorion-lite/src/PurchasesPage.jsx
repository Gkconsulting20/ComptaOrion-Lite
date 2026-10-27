import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getListPurchasesQueryKey,
  getListSuppliersQueryKey,
  useCreateLitePurchase,
  useCreateSupplier,
  useListPurchases,
  useListSuppliers,
} from '@workspace/api-client-react';
import './purchases-page.css';

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const operationKey = () => {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `lite-purchase-${random}`;
};

const money = (value, currency, language) =>
  `${Math.round(Number(value) || 0).toLocaleString(language === 'fr' ? 'fr-FR' : 'en-GB')} ${currency || 'FCFA'}`;

const dateLabel = (value, language) => {
  if (!value) return '—';
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? String(value).slice(0, 10)
    : parsed.toLocaleDateString(language === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

const emptySupplier = () => ({
  raisonSociale: '',
  numeroFournisseur: '',
  contactPrincipal: '',
  telephone: '',
  email: '',
  adresse: '',
});

const newItem = () => ({ produitId: '', quantite: '1', prixUnitaire: '' });

function SkeletonRows() {
  return <div className="purchase-skeleton" aria-label="Loading">
    {[0, 1, 2].map((row) => <div className="purchase-skeleton-row" key={row}><i /><span /><b /></div>)}
  </div>;
}

function EmptyState({ title, detail, action }) {
  return <div className="purchase-empty">
    <span className="purchase-empty-mark" aria-hidden="true">＋</span>
    <strong>{title}</strong>
    <p>{detail}</p>
    {action}
  </div>;
}

function Modal({ title, close, children, wide = false }) {
  return <div className="purchase-modal-scrim" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) close();
  }}>
    <section className={`purchase-modal ${wide ? 'purchase-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="purchase-modal-head">
        <div><span className="purchase-kicker">ComptaOrion Lite</span><h2>{title}</h2></div>
        <button type="button" className="purchase-close" onClick={close} aria-label="Close" data-testid="button-close-modal">×</button>
      </header>
      {children}
    </section>
  </div>;
}

export default function PurchasesPage({ products = [], settings = {}, t = (fr) => fr, onChanged }) {
  const queryClient = useQueryClient();
  const language = settings.language || 'fr';
  const currency = settings.currency || 'FCFA';
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  const [section, setSection] = useState('purchases');
  const [search, setSearch] = useState('');
  const [supplierOpen, setSupplierOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [supplierForm, setSupplierForm] = useState(emptySupplier);
  const [purchaseForm, setPurchaseForm] = useState({ fournisseurId: '', numeroFactureFournisseur: '', dateFacture: today(), items: [newItem()] });
  const [supplierError, setSupplierError] = useState('');
  const [purchaseError, setPurchaseError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [purchaseKey, setPurchaseKey] = useState(operationKey);
  const [supplierKey, setSupplierKey] = useState(operationKey);

  const suppliersQuery = useListSuppliers();
  const purchasesQuery = useListPurchases();
  const createSupplier = useCreateSupplier({ request: { headers: { 'X-Idempotency-Key': supplierKey } } });
  const createPurchase = useCreateLitePurchase({ request: { headers: { 'X-Idempotency-Key': purchaseKey } } });

  const suppliers = suppliersQuery.data?.data || [];
  const purchases = purchasesQuery.data?.data || [];
  const activeSuppliers = suppliers.filter((supplier) => supplier.actif);
  const filteredPurchases = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const sorted = [...purchases].sort((a, b) => String(b.dateFacture).localeCompare(String(a.dateFacture)));
    if (!query) return sorted;
    return sorted.filter((invoice) =>
      `${invoice.numeroFacture || ''} ${invoice.numeroFactureFournisseur || ''} ${invoice.fournisseur?.raisonSociale || ''}`
        .toLocaleLowerCase().includes(query));
  }, [purchases, search]);
  const supplierBalance = suppliers.reduce((sum, supplier) => sum + Number(supplier.soldeDu || 0), 0);
  const purchaseTotal = purchases.reduce((sum, invoice) => sum + Number(invoice.totalTTC || 0), 0);

  const refreshRelated = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() }),
    ]);
    onChanged?.();
  };

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const changeSupplierField = (event) => setSupplierForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  const submitSupplier = async (event) => {
    event.preventDefault();
    setSupplierError('');
    setSuccessMessage('');
    try {
      const payload = Object.fromEntries(Object.entries(supplierForm).filter(([, value]) => value.trim() !== ''));
      await createSupplier.mutateAsync({ data: payload });
      setSupplierKey(operationKey());
      setSupplierForm(emptySupplier());
      setSupplierOpen(false);
      setSuccessMessage(t('Fournisseur ajouté à votre répertoire.', 'Supplier added to your directory.'));
      await refreshRelated();
    } catch (error) {
      setSupplierError(error?.message || t('Impossible de créer ce fournisseur. Réessayez.', 'Could not create this supplier. Please try again.'));
    }
  };

  const setPurchaseItem = (index, update) => setPurchaseForm((current) => ({
    ...current,
    items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...update } : item),
  }));
  const chooseProduct = (index, value) => {
    const product = products.find((item) => String(item.id) === value);
    setPurchaseItem(index, { produitId: value, prixUnitaire: product?.prixAchat ?? '' });
  };
  const addPurchaseItem = () => setPurchaseForm((current) => ({ ...current, items: [...current.items, newItem()] }));
  const removePurchaseItem = (index) => setPurchaseForm((current) => ({
    ...current,
    items: current.items.length > 1 ? current.items.filter((_, itemIndex) => itemIndex !== index) : current.items,
  }));
  const previewTotal = purchaseForm.items.reduce(
    (sum, item) => sum + Number(item.quantite || 0) * Number(item.prixUnitaire || 0), 0,
  );
  const submitPurchase = async (event) => {
    event.preventDefault();
    setPurchaseError('');
    setSuccessMessage('');
    if (!online) {
      setPurchaseError(t('Cette opération nécessite une connexion : elle met à jour le stock et la comptabilité.', 'This operation requires a connection: it updates inventory and accounting.'));
      return;
    }
    const validItems = purchaseForm.items.every((item) =>
      item.produitId && Number(item.quantite) > 0 && Number(item.prixUnitaire) >= 0);
    if (!purchaseForm.fournisseurId || !validItems) {
      setPurchaseError(t('Choisissez un fournisseur et complétez chaque ligne produit.', 'Choose a supplier and complete each product line.'));
      return;
    }
    try {
      await createPurchase.mutateAsync({
        data: {
          fournisseurId: Number(purchaseForm.fournisseurId),
          ...(purchaseForm.numeroFactureFournisseur.trim() ? { numeroFactureFournisseur: purchaseForm.numeroFactureFournisseur.trim() } : {}),
          dateFacture: purchaseForm.dateFacture,
          items: purchaseForm.items.map((item) => ({
            produitId: Number(item.produitId),
            quantite: Number(item.quantite),
            prixUnitaire: Number(item.prixUnitaire),
          })),
        },
      });
      setPurchaseKey(operationKey());
      setPurchaseForm({ fournisseurId: '', numeroFactureFournisseur: '', dateFacture: today(), items: [newItem()] });
      setPurchaseOpen(false);
      setSuccessMessage(t('Facture enregistrée. Le stock a été actualisé.', 'Invoice recorded. Inventory has been updated.'));
      await refreshRelated();
    } catch (error) {
      setPurchaseError(error?.message || t('La facture n’a pas été enregistrée. Vérifiez la connexion puis réessayez.', 'The invoice was not recorded. Check your connection and try again.'));
    }
  };

  const retryQueries = () => {
    suppliersQuery.refetch();
    purchasesQuery.refetch();
  };

  return <div className="purchases-page">
    <div className="purchases-heading">
      <div className="purchases-title-block">
        <span className="purchase-kicker">{t('Achats · gestion des stocks', 'Purchases · inventory')}</span>
        <h1>{t('Fournisseurs & achats', 'Suppliers & purchases')}</h1>
        <p>{t('Chaque entrée de stock, reliée à sa facture et à son fournisseur.', 'Every stock arrival, tied to its invoice and supplier.')}</p>
      </div>
      <div className="purchase-network" data-testid="status-purchase-network">
        <span className={online ? 'network-light online' : 'network-light'} />
        <span>{online ? t('En ligne', 'Online') : t('Hors connexion', 'Offline')}</span>
      </div>
    </div>

    {!online && <div className="purchase-offline-banner" role="status" data-testid="message-purchase-offline">
      <strong>{t('Mode hors connexion', 'Offline mode')}</strong>
      <span>{t('Les achats modifient le stock et les comptes : leur enregistrement nécessite Internet.', 'Purchases change inventory and accounts, so saving them requires an internet connection.')}</span>
    </div>}
    {successMessage && <div className="purchase-success" role="status" data-testid="message-purchase-success">{successMessage}</div>}

    <div className="purchase-overview" aria-label={t('Résumé des achats', 'Purchase summary')}>
      <div className="purchase-overview-main">
        <span>{t('Achats enregistrés', 'Recorded purchases')}</span>
        <strong data-testid="value-purchase-total">{money(purchaseTotal, currency, language)}</strong>
        <small>{t('Total TTC · toutes les factures chargées', 'Total incl. tax · all loaded invoices')}</small>
      </div>
      <div className="purchase-overview-stat">
        <span>{t('Fournisseurs actifs', 'Active suppliers')}</span>
        <strong data-testid="value-active-suppliers">{activeSuppliers.length}</strong>
      </div>
      <div className="purchase-overview-stat">
        <span>{t('Solde dû', 'Balance due')}</span>
        <strong data-testid="value-supplier-balance">{money(supplierBalance, currency, language)}</strong>
      </div>
      <div className="purchase-stamp" aria-hidden="true"><span>STOCK</span><b>+</b></div>
    </div>

    <div className="purchase-section-bar">
      <div className="purchase-tabs" role="tablist" aria-label={t('Espace achats', 'Purchases workspace')}>
        <button type="button" role="tab" aria-selected={section === 'purchases'} className={section === 'purchases' ? 'selected' : ''}
          onClick={() => setSection('purchases')} data-testid="tab-purchases">
          {t('Factures d’achat', 'Purchase invoices')}<span>{purchases.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={section === 'suppliers'} className={section === 'suppliers' ? 'selected' : ''}
          onClick={() => setSection('suppliers')} data-testid="tab-suppliers">
          {t('Fournisseurs', 'Suppliers')}<span>{suppliers.length}</span>
        </button>
      </div>
      <div className="purchase-section-actions">
        {section === 'purchases' && <button type="button" className="purchase-button purchase-button-primary" onClick={() => {
          setPurchaseError('');
          if (!online) return;
          setPurchaseOpen(true);
        }} disabled={!online} data-testid="button-new-purchase">
          <span aria-hidden="true">＋</span>{t('Saisir un achat', 'Record purchase')}
        </button>}
        {section === 'suppliers' && <button type="button" className="purchase-button purchase-button-primary" onClick={() => {
          setSupplierError('');
          setSupplierOpen(true);
        }} data-testid="button-new-supplier"><span aria-hidden="true">＋</span>{t('Nouveau fournisseur', 'New supplier')}</button>}
      </div>
    </div>

    {section === 'purchases' ? <section className="purchase-list-panel" aria-label={t('Liste des factures', 'Invoice list')}>
      <div className="purchase-list-head">
        <div><h2>{t('Factures récentes', 'Recent invoices')}</h2><span>{t('Traçabilité par fournisseur et par produit', 'Traceable by supplier and product')}</span></div>
        <label className="purchase-search">
          <span className="sr-only">{t('Rechercher une facture', 'Search invoices')}</span>
          <span aria-hidden="true">⌕</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('Facture ou fournisseur', 'Invoice or supplier')} data-testid="input-purchase-search" />
        </label>
      </div>
      {purchasesQuery.isLoading ? <SkeletonRows /> : purchasesQuery.isError ? <div className="purchase-error-block" role="alert" data-testid="error-purchases">
        <strong>{t('Les factures ne sont pas disponibles.', 'Invoices could not be loaded.')}</strong>
        <button type="button" className="purchase-button purchase-button-secondary" onClick={() => purchasesQuery.refetch()} data-testid="button-retry-purchases">{t('Réessayer', 'Try again')}</button>
      </div> : filteredPurchases.length ? <div className="purchase-table-wrap">
        <table className="purchase-table">
          <thead><tr>
            <th>{t('Facture / date', 'Invoice / date')}</th><th>{t('Fournisseur', 'Supplier')}</th>
            <th>{t('Articles', 'Items')}</th><th className="numeric">{t('Total TTC', 'Total incl. tax')}</th>
            <th className="numeric">{t('Reste dû', 'Balance due')}</th>
          </tr></thead>
          <tbody>{filteredPurchases.map((invoice) => <tr key={invoice.id} data-testid={`row-purchase-${invoice.id}`}>
            <td><strong className="purchase-invoice-no" data-testid={`text-purchase-number-${invoice.id}`}>{invoice.numeroFacture || `#${invoice.id}`}</strong>
              <span className="purchase-table-sub">{dateLabel(invoice.dateFacture, language)}{invoice.numeroFactureFournisseur ? ` · ${invoice.numeroFactureFournisseur}` : ''}</span></td>
            <td><strong>{invoice.fournisseur?.raisonSociale || t('Fournisseur inconnu', 'Unknown supplier')}</strong>
              <span className="purchase-table-sub">{invoice.fournisseur?.numeroFournisseur || t('Aucune référence', 'No reference')}</span></td>
            <td><strong>{invoice.items?.length || 0} {t('produit(s)', 'product(s)')}</strong>
              <span className="purchase-table-sub">{(invoice.items || []).slice(0, 2).map((item) => item.description).join(', ')}</span></td>
            <td className="numeric purchase-amount">{money(invoice.totalTTC, currency, language)}</td>
            <td className="numeric"><span className={`purchase-due ${Number(invoice.soldeRestant) > 0 ? 'has-balance' : ''}`}>{money(invoice.soldeRestant, currency, language)}</span></td>
          </tr>)}</tbody>
        </table>
      </div> : <EmptyState
        title={search ? t('Aucune facture trouvée.', 'No invoices found.') : t('Aucun achat enregistré.', 'No purchases recorded yet.')}
        detail={search ? t('Essayez un autre numéro ou nom de fournisseur.', 'Try another invoice number or supplier name.') : t('Enregistrez une facture fournisseur pour actualiser le stock de produits existants.', 'Record a supplier invoice to update stock for existing products.')}
        action={!search && <button type="button" className="purchase-button purchase-button-primary" disabled={!online}
          onClick={() => setPurchaseOpen(true)} data-testid="button-empty-new-purchase">{t('Enregistrer le premier achat', 'Record your first purchase')}</button>}
      />}
    </section> : <section className="supplier-panel" aria-label={t('Répertoire fournisseurs', 'Supplier directory')}>
      <div className="supplier-panel-head">
        <div><h2>{t('Répertoire fournisseurs', 'Supplier directory')}</h2><p>{t('Un contact fiable pour chaque approvisionnement.', 'A dependable contact for every restock.')}</p></div>
        <span className="supplier-count" data-testid="text-supplier-count">{suppliers.length} {t('au total', 'in total')}</span>
      </div>
      {suppliersQuery.isLoading ? <SkeletonRows /> : suppliersQuery.isError ? <div className="purchase-error-block" role="alert" data-testid="error-suppliers">
        <strong>{t('Le répertoire ne peut pas être chargé.', 'The supplier directory could not be loaded.')}</strong>
        <button type="button" className="purchase-button purchase-button-secondary" onClick={() => suppliersQuery.refetch()} data-testid="button-retry-suppliers">{t('Réessayer', 'Try again')}</button>
      </div> : suppliers.length ? <div className="supplier-grid">
        {suppliers.map((supplier) => <article className={`supplier-card ${!supplier.actif ? 'is-inactive' : ''}`} key={supplier.id} data-testid={`card-supplier-${supplier.id}`}>
          <div className="supplier-card-top">
            <span className="supplier-monogram" aria-hidden="true">{(supplier.raisonSociale || '?').trim().slice(0, 1).toLocaleUpperCase()}</span>
            <span className={`supplier-status ${supplier.actif ? 'active' : ''}`} data-testid={`status-supplier-${supplier.id}`}>
              {supplier.actif ? t('Actif', 'Active') : t('Inactif', 'Inactive')}
            </span>
          </div>
          <h3 data-testid={`text-supplier-name-${supplier.id}`}>{supplier.raisonSociale}</h3>
          <span className="supplier-reference">{supplier.numeroFournisseur || t('Sans numéro de référence', 'No reference number')}</span>
          <div className="supplier-contact">
            {supplier.contactPrincipal && <span>{supplier.contactPrincipal}</span>}
            {supplier.telephone && <span>{supplier.telephone}</span>}
            {supplier.email && <span>{supplier.email}</span>}
            {supplier.adresse && <span>{supplier.adresse}</span>}
            {!supplier.contactPrincipal && !supplier.telephone && !supplier.email && !supplier.adresse && <span>{t('Aucune coordonnée enregistrée', 'No contact details saved')}</span>}
          </div>
          <div className="supplier-balance"><span>{t('Solde dû', 'Balance due')}</span><strong data-testid={`value-supplier-due-${supplier.id}`}>{money(supplier.soldeDu, currency, language)}</strong></div>
        </article>)}
      </div> : <EmptyState
        title={t('Votre répertoire est prêt.', 'Your directory is ready.')}
        detail={t('Ajoutez un fournisseur pour relier vos achats à la bonne entreprise.', 'Add a supplier to connect purchases to the right business.')}
        action={<button type="button" className="purchase-button purchase-button-primary" onClick={() => setSupplierOpen(true)} data-testid="button-empty-new-supplier">{t('Ajouter un fournisseur', 'Add supplier')}</button>}
      />}
    </section>}

    {(suppliersQuery.isError || purchasesQuery.isError) && <button type="button" className="purchase-retry-all" onClick={retryQueries} data-testid="button-retry-all">{t('Actualiser les données', 'Refresh data')}</button>}

    {supplierOpen && <Modal title={t('Nouveau fournisseur', 'New supplier')} close={() => setSupplierOpen(false)}>
      <form className="purchase-form" onSubmit={submitSupplier}>
        <p className="purchase-form-intro">{t('Gardez les coordonnées utiles à portée de main. Les champs autres que le nom sont facultatifs.', 'Keep useful details close. Fields other than the business name are optional.')}</p>
        <label>{t('Raison sociale', 'Business name')}<input required autoFocus maxLength="255" name="raisonSociale" value={supplierForm.raisonSociale} onChange={changeSupplierField} data-testid="input-supplier-name" /></label>
        <div className="purchase-form-grid">
          <label>{t('Numéro fournisseur', 'Supplier number')}<input maxLength="50" name="numeroFournisseur" value={supplierForm.numeroFournisseur} onChange={changeSupplierField} data-testid="input-supplier-reference" /></label>
          <label>{t('Contact principal', 'Main contact')}<input maxLength="255" name="contactPrincipal" value={supplierForm.contactPrincipal} onChange={changeSupplierField} data-testid="input-supplier-contact" /></label>
          <label>{t('Téléphone', 'Phone')}<input type="tel" maxLength="50" name="telephone" value={supplierForm.telephone} onChange={changeSupplierField} data-testid="input-supplier-phone" /></label>
          <label>{t('E-mail', 'Email')}<input type="email" maxLength="255" name="email" value={supplierForm.email} onChange={changeSupplierField} data-testid="input-supplier-email" /></label>
        </div>
        <label>{t('Adresse', 'Address')}<input name="adresse" value={supplierForm.adresse} onChange={changeSupplierField} data-testid="input-supplier-address" /></label>
        {supplierError && <div className="purchase-form-error" role="alert" data-testid="error-create-supplier">{supplierError}</div>}
        <div className="purchase-form-actions">
          <button type="button" className="purchase-button purchase-button-secondary" onClick={() => setSupplierOpen(false)} data-testid="button-cancel-supplier">{t('Annuler', 'Cancel')}</button>
          <button type="submit" className="purchase-button purchase-button-primary" disabled={createSupplier.isPending} data-testid="button-submit-supplier">
            {createSupplier.isPending ? t('Enregistrement…', 'Saving…') : t('Créer le fournisseur', 'Create supplier')}
          </button>
        </div>
      </form>
    </Modal>}

    {purchaseOpen && <Modal title={t('Enregistrer une facture d’achat', 'Record a purchase invoice')} wide close={() => setPurchaseOpen(false)}>
      <form className="purchase-form" onSubmit={submitPurchase}>
        {!online && <div className="purchase-form-error" role="alert">{t('Hors connexion : cette opération de stock et de comptabilité est uniquement disponible en ligne.', 'Offline: this inventory and accounting operation is online-only.')}</div>}
        <div className="purchase-form-grid purchase-header-fields">
          <label>{t('Fournisseur', 'Supplier')}<select required value={purchaseForm.fournisseurId} onChange={(event) => setPurchaseForm((current) => ({ ...current, fournisseurId: event.target.value }))} data-testid="select-purchase-supplier">
            <option value="">{t('Choisir un fournisseur', 'Choose a supplier')}</option>
            {activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.raisonSociale}</option>)}
          </select></label>
          <label>{t('Référence de facture fournisseur', 'Supplier invoice reference')}<input maxLength="100" value={purchaseForm.numeroFactureFournisseur} onChange={(event) => setPurchaseForm((current) => ({ ...current, numeroFactureFournisseur: event.target.value }))} data-testid="input-purchase-reference" /></label>
          <label>{t('Date de facture', 'Invoice date')}<input type="date" required value={purchaseForm.dateFacture} onChange={(event) => setPurchaseForm((current) => ({ ...current, dateFacture: event.target.value }))} data-testid="input-purchase-date" /></label>
        </div>
        <div className="purchase-lines-head"><div><h3>{t('Produits reçus', 'Products received')}</h3><span>{t('Sélectionnez des produits déjà dans votre stock.', 'Select products already in your inventory.')}</span></div><span className="purchase-item-count">{purchaseForm.items.length}</span></div>
        {!products.length && <div className="purchase-form-error" role="status" data-testid="message-no-products">{t('Aucun produit disponible. Ajoutez d’abord des produits dans votre stock.', 'No products available. Add products to your inventory first.')}</div>}
        <div className="purchase-lines">
          {purchaseForm.items.map((item, index) => {
            const product = products.find((entry) => String(entry.id) === item.produitId);
            return <fieldset className="purchase-line" key={index} data-testid={`fieldset-purchase-item-${index}`}>
              <div className="purchase-line-title"><strong>{t('Ligne', 'Line')} {index + 1}</strong>{purchaseForm.items.length > 1 && <button type="button" className="purchase-remove-line" onClick={() => removePurchaseItem(index)} aria-label={t(`Supprimer la ligne ${index + 1}`, `Remove line ${index + 1}`)} data-testid={`button-remove-purchase-item-${index}`}>×</button>}</div>
              <div className="purchase-line-grid">
                <label className="purchase-product-select">{t('Produit', 'Product')}<select required value={item.produitId} onChange={(event) => chooseProduct(index, event.target.value)} data-testid={`select-purchase-product-${index}`}>
                  <option value="">{t('Choisir un produit', 'Choose a product')}</option>
                  {products.map((entry) => <option key={entry.id} value={entry.id}>{entry.nom} · {t('stock', 'stock')} {entry.quantite}</option>)}
                </select></label>
                <label>{t('Quantité reçue', 'Quantity received')}<input type="number" min="0.01" step="0.01" required value={item.quantite} onChange={(event) => setPurchaseItem(index, { quantite: event.target.value })} data-testid={`input-purchase-quantity-${index}`} /></label>
                <label>{t('Prix unitaire', 'Unit price')}<input type="number" min="0" step="0.01" required value={item.prixUnitaire} onChange={(event) => setPurchaseItem(index, { prixUnitaire: event.target.value })} data-testid={`input-purchase-price-${index}`} /></label>
              </div>
              <div className="purchase-line-bottom">
                <span>{product ? `${t('Stock actuel', 'Current stock')}: ${product.quantite}` : t('Sélectionnez un produit du stock', 'Choose an inventory product')}</span>
                <strong data-testid={`value-purchase-line-total-${index}`}>{money(Number(item.quantite || 0) * Number(item.prixUnitaire || 0), currency, language)}</strong>
              </div>
            </fieldset>;
          })}
        </div>
        <button type="button" className="purchase-add-line" onClick={addPurchaseItem} disabled={!products.length || purchaseForm.items.length >= 50} data-testid="button-add-purchase-item"><span>＋</span>{t('Ajouter un produit', 'Add a product')}</button>
        <div className="purchase-total-row"><span>{t('Total estimatif HT', 'Estimated subtotal')}</span><strong data-testid="value-purchase-preview-total">{money(previewTotal, currency, language)}</strong></div>
        <p className="purchase-online-note"><span className={online ? 'network-light online' : 'network-light'} />{t('Enregistrement en ligne requis pour mettre à jour le stock et la comptabilité.', 'Online save required to update inventory and accounting.')}</p>
        {purchaseError && <div className="purchase-form-error" role="alert" data-testid="error-create-purchase">{purchaseError}</div>}
        <div className="purchase-form-actions">
          <button type="button" className="purchase-button purchase-button-secondary" onClick={() => setPurchaseOpen(false)} data-testid="button-cancel-purchase">{t('Annuler', 'Cancel')}</button>
          <button type="submit" className="purchase-button purchase-button-primary" disabled={!online || createPurchase.isPending || !products.length || !activeSuppliers.length} data-testid="button-submit-purchase">
            {createPurchase.isPending ? t('Enregistrement…', 'Saving…') : t('Enregistrer l’achat', 'Save purchase')}
          </button>
        </div>
      </form>
    </Modal>}
  </div>;
}
