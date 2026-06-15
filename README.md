# Draw Probability Calculator

A dependency-free static prototype for exact draw probabilities from a shuffled deck.

Open `index.html` in a browser.

## Site link

Edit the `MARKETING` object near the top of `app.js` to set the header site URL and link label.

## Basic mode

Use this when all success cards are interchangeable.

Inputs:

- `Deck size`
- `Successes in deck`
- `Initial hand`
- `Replacement count / limit`
- `Additional draws`
- `Target successes`
- `Replacement method`
- `Replaced cards shuffled in`

`Up to this many non-successes` replaces at most the entered number of non-success cards and never replaces successes. If the hand has fewer non-success cards than the limit, fewer cards are replaced. `Exactly this many random cards` replaces a random subset of the initial hand and can replace successes.

`Before drawing replacements` shuffles replaced cards back before drawing replacement cards. `After drawing replacements` draws replacements from the remaining deck first, then shuffles replaced cards back before additional draws.

## Combo mode

Use deck rows with quantities and roles. Roles are comma- or space-separated.

Use target rows to define the combo:

- Rows with the same line number are all required.
- Different line numbers are alternatives.
- A target row with multiple roles means any card with one of those roles can count.

The app generates an internal expression from those rows. The expression supports:

```text
A>=1 + B>=1
any(A,B,C)>=2
A>=1 + B>=1 | combo>=3
```

`+` means all requirements in that line must be met. `|` means any line can satisfy the combo. A row with the wildcard role can cover missing requirements one-for-one.

Combo mode uses exact enumeration over active role groups, capped at 9 groups to keep the browser responsive.
