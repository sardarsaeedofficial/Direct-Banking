package uk.co.prisom.directbanking.parsing

/**
 * Anonymised notification fixtures exercising the capture → parse pipeline.
 * No real account numbers, names or card numbers are used.
 */
data class Fixture(
    val name: String,
    val input: NotificationInput,
    val parseable: Boolean,
    val direction: TransactionDirection? = null,
    val amountMinor: Long? = null,
    val currency: String = "GBP",
    val merchantContains: String? = null,
    val minConfidence: Double? = null,
    val maxConfidence: Double? = null,
)

object NotificationFixtures {
    private const val T = 1_722_800_000_000L // fixed post time

    private fun n(pkg: String, title: String? = null, text: String? = null, big: String? = null, lines: List<String> = emptyList(), sub: String? = null) =
        NotificationInput(sourcePackage = pkg, postTime = T, title = title, text = text, bigText = big, textLines = lines, subText = sub)

    val all: List<Fixture> = listOf(
        // --- Debits / card payments ---
        Fixture("monzo spend", n("co.uk.getmondo", title = "Tesco", text = "You spent £12.45"), true, TransactionDirection.EXPENSE, 1245, merchantContains = "Tesco", minConfidence = 0.9),
        Fixture("card payment at pret", n("com.example.bank", text = "Card payment of £5.99 at Pret A Manger"), true, TransactionDirection.EXPENSE, 599, merchantContains = "Pret"),
        Fixture("contactless", n("com.example.bank", text = "Contactless payment £3.20 at Costa Coffee"), true, TransactionDirection.EXPENSE, 320, merchantContains = "Costa"),
        Fixture("negative amount debit", n("com.example.bank", text = "-£12.50 Sainsbury's"), true, TransactionDirection.EXPENSE, 1250),
        Fixture("direct debit", n("com.example.bank", text = "Direct debit of £42.00 to British Gas"), true, TransactionDirection.EXPENSE, 4200, merchantContains = "British Gas"),
        Fixture("transfer out", n("com.example.bank", text = "You sent £100.00 to Jane"), true, TransactionDirection.EXPENSE, 10000),
        Fixture("cash withdrawal", n("com.example.bank", text = "Cash withdrawal £30.00 at ATM"), true, TransactionDirection.EXPENSE, 3000),
        Fixture("large debit thousands", n("com.example.bank", text = "Card payment of £1,234.56 at Apple Store"), true, TransactionDirection.EXPENSE, 123456, merchantContains = "Apple"),
        Fixture("starling spent", n("com.starlingbank.android", text = "You spent £8.75 at Boots"), true, TransactionDirection.EXPENSE, 875, merchantContains = "Boots", minConfidence = 0.9),
        Fixture("revolut bullet", n("com.revolut.revolut", text = "£15.00 • Uber"), true, TransactionDirection.EXPENSE, 1500, minConfidence = 0.9),
        Fixture("purchase word", n("com.example.bank", text = "Purchase £22.99 at ASOS"), true, TransactionDirection.EXPENSE, 2299, merchantContains = "ASOS"),
        Fixture("you paid", n("com.example.bank", text = "You paid £60.00 to Council Tax"), true, TransactionDirection.EXPENSE, 6000),

        // --- Credits / income ---
        Fixture("starling received", n("com.starlingbank.android", text = "Received £50.00 from John Smith"), true, TransactionDirection.INCOME, 5000, minConfidence = 0.9),
        Fixture("salary", n("com.example.bank", text = "You've been paid in £1,850.00 salary"), true, TransactionDirection.INCOME, 185000),
        Fixture("credited", n("com.example.bank", text = "£250.00 credited to your account"), true, TransactionDirection.INCOME, 25000),
        Fixture("interest", n("com.example.bank", text = "Interest of £1.23 credited"), true, TransactionDirection.INCOME, 123),
        Fixture("cashback", n("com.example.bank", text = "You earned £2.50 cashback"), true, TransactionDirection.INCOME, 250),
        Fixture("deposit", n("com.example.bank", text = "Cash deposit £40.00 received"), true, TransactionDirection.INCOME, 4000),

        // --- Refunds (income) ---
        Fixture("refund amazon", n("com.example.bank", text = "Refund of £19.99 from Amazon"), true, TransactionDirection.INCOME, 1999, merchantContains = "Amazon"),
        Fixture("refund merchant", n("com.example.bank", text = "You were refunded £7.50 by Deliveroo"), true, TransactionDirection.INCOME, 750),

        // --- Currency variants ---
        Fixture("gbp prefix word", n("com.example.bank", text = "Payment of GBP 1,234.56 to Landlord"), true, TransactionDirection.EXPENSE, 123456, "GBP"),
        Fixture("gbp suffix word", n("com.example.bank", text = "Debit 1,234.56 GBP HMRC"), true, TransactionDirection.EXPENSE, 123456, "GBP"),
        Fixture("usd payment", n("com.example.bank", text = "Card payment of $12.00 at App Store"), true, TransactionDirection.EXPENSE, 1200, "USD"),
        Fixture("eur payment", n("com.example.bank", text = "You spent €9.90 at Lidl"), true, TransactionDirection.EXPENSE, 990, "EUR"),
        Fixture("no decimals", n("com.example.bank", text = "You spent £20 at Greggs"), true, TransactionDirection.EXPENSE, 2000),
        Fixture("one decimal", n("com.example.bank", text = "You spent £5.5 at Shop"), true, TransactionDirection.EXPENSE, 550),

        // --- Account hints / redaction ---
        Fixture("account ending", n("com.example.bank", text = "You spent £11.00 at Tesco, card ending 1234"), true, TransactionDirection.EXPENSE, 1100),
        Fixture("masked card", n("com.example.bank", text = "You paid £9.00 on card •• 4321"), true, TransactionDirection.EXPENSE, 900),

        // --- Unsupported / non-financial ---
        Fixture("parcel", n("com.example.delivery", title = "Delivery", text = "Your parcel is out for delivery"), false),
        Fixture("news", n("com.example.news", text = "Breaking: markets rise today"), false),
        Fixture("no currency number", n("com.example.bank", text = "You have 3 new statements"), false),
        Fixture("balance only no direction", n("com.example.bank", text = "Your balance is £532.10"), false, maxConfidence = 0.6),

        // --- Low confidence ---
        Fixture("amount only no direction", n("com.example.bank", text = "£10.00"), false),
    )
}
