---
name: Comptabilisation des chèques
description: Règle de traitement des chèques clients reçus et déposés dans ComptaOrion Lite.
---

**Règle :** La réception d’un chèque crédite immédiatement le compte client et débite le compte 513 « chèques à encaisser ». Le dépôt bancaire ultérieur transfère le montant du compte 513 vers la banque sans modifier une seconde fois le compte client. Aucun écran de confirmation du client n’est requis.

**Distinction client :** Un paiement reçu est un règlement qui réduit la créance; ce n’est pas un avoir. Un avoir client est créé seulement par le retour de marchandise correspondant, qui ajuste aussi le stock selon l’état de l’article.

**Why:** l’utilisateur a explicitement demandé ce traitement; le dépôt est une opération de trésorerie après réception, pas une nouvelle opération client.

**How to apply:** conserver la distinction entre facture, paiement et retour/avoir dans les relevés, écritures et rapports; ne jamais créditer le client à nouveau lors du dépôt.
