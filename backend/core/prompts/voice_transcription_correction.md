# Prompt — correction de transcription SOS vocal

## Objectif

Corriger une transcription automatique issue de Whisper avant l'extraction des informations d'un SOS urgent.

La transcription Whisper peut contenir des erreurs phonétiques, notamment sur les noms algériens, les wilayas, communes, quartiers, organisations et noms propres.

## Liste fermée des wilayas d'Algérie

Chaque wilaya est donnée sous la forme « Nom français (الاسم بالعربية) ».

{{WILAYA_LIST}}

Cette liste est la SEULE source valide de noms de wilaya, en français comme en arabe. Un mot ne peut être corrigé en nom de wilaya que s'il correspond à l'une de ces deux orthographes officielles.

## Règles impératives

1. La transcription originale est la seule source de vérité.
2. Corriger uniquement les erreurs manifestes de reconnaissance vocale, de ponctuation, d'espacement ou d'accord qui sont directement déductibles du contexte.
3. Ne jamais inventer une information absente de la transcription.
4. Ne jamais ajouter de nom, prénom, téléphone, quantité, adresse, commune, wilaya, organisation ou détail de besoin qui n'est pas réellement présent ou fortement identifiable dans les mots prononcés.
5. Les coordonnées GPS fournies par le navigateur peuvent servir UNIQUEMENT à désambiguïser une localisation déjà présente phonétiquement dans la transcription. Elles ne doivent jamais servir à inventer une localisation qui n'a pas été prononcée.
6. Si un mot ressemble phonétiquement à une wilaya de la liste fermée ci-dessus, corriger vers l'orthographe EXACTE de cette liste dès que la ressemblance phonétique est suffisamment évidente, même sans coordonnées GPS. Si des coordonnées GPS sont disponibles et compatibles, elles renforcent la confiance dans cette correction.
7. Exemple (français) : si Whisper produit « Tizi Ozu », « Tizi Ou zou », « Tiziouzou » ou une forme phonétique très proche, corriger vers « Tizi Ouzou » (présent dans la liste), que le GPS soit disponible ou non. De même « Citef », « Citéf » ou « Cétif » doivent être corrigés vers « Sétif » (présent dans la liste).
8. Ne jamais écrire un nom de wilaya qui n'apparaît PAS dans la liste fermée ci-dessus (dans aucune des deux langues). Si le mot entendu ne correspond avec confiance à aucune entrée de la liste, conserver le mot original tel qu'entendu plutôt que d'inventer ou d'approximer un nom proche.
9. Si la transcription est en arabe (ou en darija algérienne transcrite en caractères arabes), corriger un nom de wilaya déformé phonétiquement vers l'orthographe arabe EXACTE de la liste fermée, jamais vers le français : ne traduis jamais une langue vers l'autre, corrige uniquement l'orthographe dans la langue effectivement prononcée. Exemple : une transcription Whisper approximative comme « سطايف » ou « سيطيف » doit être corrigée en « سطيف » (et non en « Sétif »).
10. Si la transcription mélange français et arabe (courant en Algérie), ne corrige chaque mot que dans sa propre langue ; ne convertis pas un mot arabe en français ni l'inverse.
11. En revanche, si la transcription dit seulement « aux médicaments matériels » sans aucune mention phonétique identifiable d'une commune ou wilaya, ne pas déduire une localisation à partir des coordonnées seules.
12. Conserver le sens et le niveau d'information de la transcription. Ne pas enrichir le discours.
13. En cas de doute, conserver la formulation originale plutôt que de deviner.
14. Ne pas reformuler le message en résumé. La sortie doit rester aussi proche que possible du texte original.
15. Respecter le français, l'arabe et les mélanges français/arabe courants en Algérie.
16. Les noms propres algériens (communes, quartiers, organisations) doivent être normalisés avec leur orthographe officielle uniquement lorsqu'une correspondance phonétique et contextuelle fiable existe ; pour les wilayas, la règle 8 prime toujours.

## Utilisation du contexte géographique

Le contexte GPS est un signal de désambiguïsation, pas une source de contenu.

- GPS dans la région de Tizi Ouzou + transcription « Tizi Ozu » => « Tizi Ouzou » peut être retenu.
- GPS à Oran + transcription « Wahran » => « Oran » peut être retenu si le mot prononcé est clairement cette variante phonétique.
- GPS à Alger + aucune mention d'Alger dans l'audio => ne pas ajouter « Alger ».
- GPS à Tizi Ouzou + transcription ambiguë sans aucun indice phonétique de Tizi Ouzou => ne pas ajouter « Tizi Ouzou ».

## Sortie obligatoire

Retourner uniquement le texte corrigé, sans commentaire, sans explication et sans JSON.

Si aucune correction fiable n'est possible, retourner exactement la transcription originale.
