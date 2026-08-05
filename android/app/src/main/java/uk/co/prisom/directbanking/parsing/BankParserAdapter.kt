package uk.co.prisom.directbanking.parsing

/** A deterministic, package-specific parser tried before the generic parser. */
interface BankParserAdapter : NotificationParser {
    val packages: Set<String>
    fun handles(packageName: String): Boolean = packageName in packages
}

/**
 * Shared behaviour for bank adapters: a matched package with a clear amount and
 * direction yields high confidence (eligible for auto-draft). Subclasses can
 * refine merchant/direction detection for their notification format.
 */
abstract class BaseBankAdapter(override val packages: Set<String>) : BankParserAdapter {

    protected open fun merchantOf(input: NotificationInput, text: String): String? =
        // Many bank apps put the merchant in the title and the amount in the body.
        input.title?.takeIf { t -> Money.firstAmount(t) == null && t.length in 2..40 }
            ?: MerchantRules.extract(text)

    // A matched bank notification with an amount is a spend unless the text
    // clearly signals income (received/refund/credited/…).
    protected open fun directionOf(text: String, negative: Boolean): TransactionDirection =
        DirectionRules.detect(text) ?: TransactionDirection.EXPENSE

    override fun parse(input: NotificationInput): ParsedTransactionCandidate? {
        if (!handles(input.sourcePackage)) return null
        val text = input.combinedText
        val amount = Money.firstAmount(text) ?: return null
        val direction = directionOf(text, amount.negative)
        val merchant = merchantOf(input, text)
        val accountHint = Redaction.accountHint(text)

        // Deterministic adapter with amount + direction → high confidence.
        var confidence = 0.90
        if (merchant != null) confidence += 0.05
        if (accountHint != null) confidence += 0.03
        confidence = confidence.coerceAtMost(0.98)

        return ParsedTransactionCandidate(
            direction = direction,
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

/** Monzo. */
class MonzoParser : BaseBankAdapter(setOf("co.uk.getmondo", "com.monzo.app"))

/** Starling Bank. */
class StarlingParser : BaseBankAdapter(setOf("com.starlingbank.android"))

/** Revolut — format is often "£12.45 • Merchant". */
class RevolutParser : BaseBankAdapter(setOf("com.revolut.revolut")) {
    override fun merchantOf(input: NotificationInput, text: String): String? {
        val afterBullet = text.substringAfter("•", "").trim()
        return afterBullet.takeIf { it.isNotBlank() && it.length in 2..40 }
            ?: super.merchantOf(input, text)
    }
}
