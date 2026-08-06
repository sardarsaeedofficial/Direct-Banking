package uk.co.prisom.directbanking.parsing

/**
 * Routes a notification to a deterministic package-specific adapter when one
 * matches, otherwise falls back to the generic financial parser.
 */
class ParserRegistry(
    private val adapters: List<BankParserAdapter> = defaultAdapters(),
    private val generic: NotificationParser = GenericFinancialParser(),
) {
    fun parse(input: NotificationInput): ParsedTransactionCandidate? {
        val adapter = adapters.firstOrNull { it.handles(input.sourcePackage) }
        adapter?.parse(input)?.let { return it }
        return generic.parse(input)
    }

    companion object {
        fun defaultAdapters(): List<BankParserAdapter> = listOf(
            MonzoParser(),
            StarlingParser(),
            RevolutParser(),
        )
    }
}
