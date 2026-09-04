import re

# Used when a Need/Pickup owner or an admin anonymizes a listing
# (IdentityListingMixin.anonymize -> anonymize_identity_fields on each
# model). Previously these fields were replaced outright ("Anonymized",
# ""), which is real server-side data removal (not just CSS/UI hiding --
# the original value is genuinely gone) but reads as broken in the UI: an
# untranslated English placeholder for the name, and a phone number that
# just vanishes with a dangling "show number" toggle next to nothing.
#
# Masking instead of blanking keeps that same guarantee (every original
# digit/letter is destroyed, never recoverable) while giving visible
# confirmation that anonymization actually happened.


def mask_identity_name(name):
    """"Ahmed Hamraoui" -> "A***** H******" -- first letter of each word
    kept, the rest replaced one-for-one with '*'. Works for any name
    (single word, more than two words, non-Latin scripts) since it only
    ever looks at word boundaries, never a fixed name/surname split."""
    if not name:
        return name
    return " ".join(word[0] + "*" * (len(word) - 1) if word else word for word in name.split(" "))


def mask_identity_phone(phone):
    """Every digit replaced with 'X', everything else (a leading '+',
    spaces, parentheses) left as-is -- so "0655112233" -> "XXXXXXXXXX"
    and "+213 655 11 22 33" -> "+XXX XXX XX XX XX", regardless of which
    of the app's real phone formats (06/07/05 local, +213 international)
    was stored. A plain digit-substitution regex rather than a fixed
    slice/length assumption, so it can't garble a format it wasn't
    written for."""
    if not phone:
        return phone
    return re.sub(r"\d", "X", phone)
