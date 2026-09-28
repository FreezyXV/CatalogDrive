# Formats de catalogues pris en charge

Les formats suivants sont acceptés par le dépôt, le diagnostic, le mapping et le traitement. Leur liste est visible discrètement sur l’accueil et dans l’en-tête de la zone d’import. Les précisions restent repliées sous « Précisions sur les formats et limites ».

| Format | Contenu attendu                                                  | Particularités                                                                                                                                                       |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV    | Tableau séparé par virgule, point-virgule ou tabulation          | Guillemets et cellules multilignes conservés ; UTF-8, UTF-16LE avec BOM et Windows-1252.                                                                             |
| TSV    | Tableau séparé par tabulations                                   | Même pipeline en flux que le CSV.                                                                                                                                    |
| TXT    | Tableau délimité, avec une ligne d’en-tête                       | Virgule, point-virgule ou tabulation ; texte libre et largeur fixe non pris en charge.                                                                               |
| XLSX   | Classeur Excel moderne                                           | Lecture des cellules en flux après précontrôle ; choix de feuille/en-tête ; formules conservées comme texte.                                                         |
| XLS    | Ancien classeur Excel BIFF, ou XLSX portant une extension `.xls` | Ancien binaire limité à **16 Mio**, lu avec SheetJS ; un XLSX renommé passe par le lecteur XLSX. BIFF8 possède sa propre limite native de 65 536 lignes par feuille. |
| ODS    | Classeur OpenDocument / LibreOffice Calc                         | Lecture XML en flux ; répétitions de lignes/cellules bornées ; espaces, paragraphes et formules préservés.                                                           |
| ZIP    | Un ou plusieurs catalogues des six formats ci-dessus             | **20 fichiers** maximum, **100 Mio** décompressés au total ; un import par catalogue ; annulation du lot entier si une entrée échoue.                                |

La limite applicative est de **500 000 lignes de données par fichier texte ou par feuille**, hors en-tête et lignes entièrement vides. Les cellules multilignes CSV comptent comme un seul enregistrement. La limite de 200 colonnes, 64 K caractères par ligne et 20 lignes d’aperçu reste active.

Les classeurs XLSX/ODS sont bornés à **256 Mio décompressés au total**, **192 Mio par feuille XML ou contenu ODS** et **32 Mio par fichier de métadonnées**. Le XLSX utilise une copie temporaire avec les métadonnées avant les feuilles pour éviter les dépendances du lecteur ExcelJS à l’ordre du ZIP ; l’original reste identique. Les macros, archives chiffrées, chemins dangereux, entrées dupliquées, expansion excessive et déclarations DTD ODS sont refusés. Aucune formule ni ressource distante n’est exécutée.

Le lecteur des anciens XLS utilise [la distribution officielle SheetJS 0.20.3](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/), plutôt que l’ancienne version du registre npm. L’ODS utilise un lecteur SAX en flux ; aucune conversion par service externe n’est simulée.

PDF, images, DOCX, XLSM, XLSB, JSON, flux XML métier, RAR et 7z ne sont pas annoncés compatibles. Leurs données nécessitent des adaptateurs ou une extraction spécifique ; renommer leur extension ne les rend pas importables.

## Volume et vérification

- Les bornes **500 000 / 500 001** sont testées pour CSV, XLSX et ODS. Le test XLSX comprend une feuille placée avant les métadonnées et un chemin de relation absolu.
- Un TSV propre de **500 000 lignes**, avec SKU, désignation et devise explicites et recherche floue désactivée, a passé diagnostic, normalisation, export et accès à la page 10 000 dans PostgreSQL local. Le premier essai a pris **190 secondes** et occupé environ **276 Mo de base** ; ce résultat ne garantit pas les mêmes durées ni la même occupation avec des descriptions, transformations ou anomalies nombreuses.
- Le fichier utilisateur `shafercross07052024.xls` est réellement un XLSX : **122 765 lignes de données**, quatre colonnes, feuille `TDSheet`. Sa lecture locale a réussi. C’est une table de correspondances de pièces sans désignation produit ; son exploitation comme table d’équivalences nécessite un mode métier distinct, sans inventer de désignations pour satisfaire le mapping catalogue.
- La taille du dépôt dépend de l’environnement : **50 Mo en production Supabase**, **200 Mo sur la Preview B2**. Les catalogues exportés et rapports restent limités à **50 Mio chacun**. La limite de lignes ne supprime pas ces limites en octets, le quota de base ou la durée maximale des fonctions hébergées.

Les preuves de déploiement et tests navigateur sont consignées dans [VERIFICATION.md](VERIFICATION.md). Le statut de commercialisation reste celui de [COMMERCIALISATION.md](COMMERCIALISATION.md).
