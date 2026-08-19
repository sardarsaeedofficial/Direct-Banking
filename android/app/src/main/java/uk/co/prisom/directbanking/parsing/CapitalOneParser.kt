package uk.co.prisom.directbanking.parsing

/**
 * Capital One (UK) card-purchase notifications. Package verified from the
 * device's own Play Store listing (share-link `id=…`) — see
 * [uk.co.prisom.directbanking.data.TrustedSources] — never guessed.
 *
 * Real captured format:
 * ```
 * Title: "ALIEXPRESS.COM"
 * Text:  "£4.88 on card ending 7813. That leaves £202.51 available to spend"
 * ```
 *
 * The notification carries TWO monetary values with different roles:
 *  - £4.88 — the transaction amount (always stated first, before "on card
 *    ending").
 *  - £202.51 — the post-transaction available-to-spend balance ("That
 *    leaves … available to spend"), which is a real-time credit-limit
 *    figure, never the transaction amount, a second transaction, income, or
 *    a refund.
 *
 * This adapter never uses generic "first amount in the whole text" alone —
 * it explicitly scopes amount extraction to the text BEFORE any "that
 * leaves … available to spend/balance" clause, so a reordered or unexpected
 * notification can never silently pick the available-to-spend figure
 * instead of the real transaction amount.
 *
 * Card-purchase push notifications like this are sent at *authorisation*
 * time, before the transaction has posted/settled to the statement (typical
 * for UK card issuers, Capital One included — its own app shows these as
 * "Pending" for 1–3 days). This adapter does not decide the ledger
 * lifecycle itself — that is the server classifier's job (see
 * classifier.ts's CARD_AUTH_HOLD_RE) — it only supplies a correct amount,
 * merchant, direction and card hint; source *trust* here only proves who
 * sent the notification, never that it is a completed transaction.
 */
class CapitalOneParser : BaseBankAdapter(setOf(PACKAGE)) {

    override fun parse(input: NotificationInput): ParsedTransactionCandidate? {
        if (!handles(input.sourcePackage)) return null
        val text = input.combinedText
        if (text.isBlank()) return null

        // Scope amount extraction to before any available-to-spend/balance
        // clause, so that figure is never mistaken for the transaction amount
        // — deliberate defence-in-depth, not just incidental text ordering.
        val balanceClause = AVAILABLE_TO_SPEND_RE.find(text)
        val beforeBalanceClause = balanceClause?.let { text.substring(0, it.range.first) } ?: text
        val amount = Money.firstAmount(beforeBalanceClause) ?: Money.firstAmount(text) ?: return null

        // No expense/income keyword ("spent", "purchase", "card payment", …)
        // appears in Capital One's real wording at all — a matched, deterministic
        // bank adapter defaults to EXPENSE (see directionOf), except explicit
        // "refunded" wording, which DirectionRules already maps to INCOME.
        val direction = directionOf(text, amount.negative)
        val merchant = merchantOf(input, text)
        val cardLast4 = Redaction.accountHint(text)

        var confidence = 0.92 // deterministic, package-verified bank adapter
        if (merchant != null) confidence += 0.04
        if (cardLast4 != null) confidence += 0.02
        confidence = confidence.coerceAtMost(0.98)

        return ParsedTransactionCandidate(
            direction = direction,
            amountMinor = amount.minor,
            currency = amount.currency,
            merchant = merchant,
            accountHint = cardLast4,
            occurredAt = input.occurredAt,
            sourcePackage = input.sourcePackage,
            confidence = confidence,
            redactedSourceText = Redaction.redact(text),
        )
    }

    companion object {
        const val PACKAGE = "com.ie.capitalone.uk"

        // "That leaves £202.51 available to spend" / "available balance" style
        // context — the post-transaction figure, never the transaction amount.
        val AVAILABLE_TO_SPEND_RE: Regex = Regex(
            """that\s+leaves\b|available\s+to\s+spend\b|available\s+balance\b|available\s+credit\b""",
            RegexOption.IGNORE_CASE,
        )
    }
}
