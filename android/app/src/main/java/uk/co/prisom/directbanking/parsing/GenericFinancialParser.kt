package uk.co.prisom.directbanking.parsing

/**
 * Fallback parser for any approved source without a dedicated adapter. It relies
 * on an explicit currency amount plus a direction keyword. Confidence is capped
 * so generic results generally require user review before import.
 */
class GenericFinancialParser : NotificationParser {

    override fun parse(input: NotificationInput): ParsedTransactionCandidate? {
        val text = input.combinedText
        if (text.isBlank()) return null

        val amount = Money.firstAmount(text) ?: return null // no currency amount → not a transaction
        val direction = DirectionRules.detect(text)
            ?: if (amount.negative) TransactionDirection.EXPENSE else null
        val resolvedDirection = direction ?: return null

        val merchant = MerchantRules.extract(text)
        val accountHint = Redaction.accountHint(text)

        var confidence = 0.50 // has a currency amount
        confidence += 0.25 // has a direction signal (required above)
        if (merchant != null) confidence += 0.10
        if (accountHint != null) confidence += 0.05
        confidence = confidence.coerceAtMost(0.85) // generic never auto-imports without review

        return ParsedTransactionCandidate(
            direction = resolvedDirection,
            amountMinor = amount.minor,
            currency = amount.currency,
            merchant = merchant,
            accountHint = accountHint,
            occurredAt = input.occurredAt,
            sourcePackage = input.sourcePackage,
            confidence = confidence,
            redactedSourceText = Redaction.redact(text),
        )
    }
}
