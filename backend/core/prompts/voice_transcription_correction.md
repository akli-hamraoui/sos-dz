# Prompt — correction de transcription SOS vocal

## Objectif

Corriger une transcription automatique issue de Whisper avant l'extraction des informations d'un SOS urgent.

La transcription Whisper peut contenir des erreurs phonétiques, notamment sur les noms algériens, les wilayas, communes, quartiers, organisations et noms propres.

## Règles impératives

1. La transcription originale est la seule source de vérité.
2. Corriger uniquement les erreurs manifestes de reconnaissance vocale, de ponctuation, d'espacement ou d'accord qui sont directement déductibles du contexte.
3. Ne jamais inventer une information absente de la transcription.
4. Ne jamais ajouter de nom, prénom, téléphone, quantité, adresse, commune, wilaya, organisation ou détail de besoin qui n'est pas réellement présent ou fortement identifiable dans les mots prononcés.
5. Les coordonnées GPS fournies par le navigateur peuvent servir UNIQUEMENT à désambiguïser une localisation déjà présente phonétiquement dans la transcription. Elles ne doivent jamais servir à inventer une localisation qui n'a pas été prononcée.
6. Si un mot ressemble phonétiquement à une commune ou wilaya algérienne et que les coordonnées GPS sont compatibles avec cette localisation, corriger le mot vers le nom officiel uniquement si cette correction est suffisamment évidente.
7. Exemple : si Whisper produit « Tizi Ozu », « Tizi Ou zou », « Tiziouzou » ou une forme phonétique très proche, et que les coordonnées sont compatibles avec Tizi Ouzou, la correction peut être « Tizi Ouzou ».
8. En revanche, si la transcription dit seulement « aux médicaments matériels » sans aucune mention phonétique identifiable d'une commune, ne pas déduire une commune à partir des coordonnées seules.
9. Conserver le sens et le niveau d'information de la transcription. Ne pas enrichir le discours.
10. En cas de doute, conserver la formulation originale plutôt que de deviner.
11. Ne pas reformuler le message en résumé. La sortie doit rester aussi proche que possible du texte original.
12. Respecter le français, l'arabe et les mélanges français/arabe courants en Algérie.
13. Les noms propres algériens doivent être normalisés avec leur orthographe officielle uniquement lorsqu'une correspondance phonétique et contextuelle fiable existe.

## Utilisation du contexte géographique

Le contexte GPS est un signal de désambiguïsation, pas une source de contenu.

- GPS dans la région de Tizi Ouzou + transcription « Tizi Ozu » => « Tizi Ouzou » peut être retenu.
- GPS à Oran + transcription « Wahran » => « Oran » peut être retenu si le mot prononcé est clairement cette variante phonétique.
- GPS à Alger + aucune mention d'Alger dans l'audio => ne pas ajouter « Alger ».
- GPS à Tizi Ouzou + transcription ambiguë sans aucun indice phonétique de Tizi Ouzou => ne pas ajouter « Tizi Ouzou ».

## Sortie obligatoire

Retourner uniquement le texte corrigé, sans commentaire, sans explication et sans JSON.

Si aucune correction fiable n'est possible, retourner exactement la transcription originale.
