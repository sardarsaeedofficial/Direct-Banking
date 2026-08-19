package uk.co.prisom.directbanking.data

import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import java.security.MessageDigest

/**
 * Explicit trust classification for a notification source.
 *
 * - [SIGNATURE_VERIFIED] — a built-in banking package **and** the installed app's
 *   signing certificate SHA-256 matches an allowed pin. This is the only level
 *   that proves cryptographic authenticity.
 * - [PACKAGE_ID_ONLY] — a built-in banking package by exact id, but no signing
 *   certificate pin is configured (or could not be read), so authenticity is not
 *   cryptographically proven. Trusted by package id alone.
 * - [USER_APPROVED] — a non-built-in source the user explicitly approved.
 * - [UNAPPROVED] — unknown, or a built-in package whose signature was checked
 *   against configured pins and did **not** match (a likely spoof).
 */
enum class SourceTrustLevel {
    SIGNATURE_VERIFIED,
    PACKAGE_ID_ONLY,
    USER_APPROVED,
    UNAPPROVED,
}

/**
 * Result of classifying a source, including what diagnostics needs to explain the
 * decision without leaking the full certificate to ordinary users.
 *
 * @param signatureChecked whether the installed app's signing certificate was read.
 * @param signatureMatched true/false when pins are configured and were compared;
 *   null when there is nothing to match against ("not configured").
 * @param signingSha256Abbrev an abbreviated, non-reversible view of the installed
 *   signer for diagnostics, or null when unavailable.
 */
data class SourceTrust(
    val level: SourceTrustLevel,
    val builtIn: Boolean,
    val signatureChecked: Boolean,
    val signatureMatched: Boolean?,
    val signingSha256Abbrev: String?,
)

/** Reads the installed signing certificate SHA-256 hex hashes for a package. */
interface SignatureInspector {
    /** Returns the set of signer SHA-256 hex strings, or null if not installed / unreadable. */
    fun sha256Signers(packageName: String): Set<String>?

    companion object {
        /** No-op inspector (used where no Android context is available, e.g. unit tests). */
        val None: SignatureInspector = object : SignatureInspector {
            override fun sha256Signers(packageName: String): Set<String>? = null
        }
    }
}

/**
 * Built-in trusted UK banking apps, keyed by their **exact** official Android
 * package id (a visible label of "Barclays" etc. is never enough on its own).
 *
 * [Trusted.signingSha256] holds optional certificate pins. They are intentionally
 * left **empty**: shipping unverified certificate hashes obtained from APK mirrors,
 * blogs or scraped metadata would be worse than none. Populate a package's pins
 * only from an authoritative source to promote it from [SourceTrustLevel.PACKAGE_ID_ONLY]
 * to [SourceTrustLevel.SIGNATURE_VERIFIED]. Multiple pins per package are supported
 * for legitimate signing-key rotation.
 */
object TrustedSources {

    data class Trusted(
        val packageName: String,
        val displayName: String,
        /** Allowed signing-certificate SHA-256 pins (any format; normalized on compare). */
        val signingSha256: Set<String> = emptySet(),
    )

    val all: List<Trusted> = listOf(
        Trusted("co.uk.getmondo", "Monzo"),
        Trusted("com.revolut.revolut", "Revolut"),
        Trusted("com.starlingbank.android", "Starling"),
        Trusted("com.barclays.android.barclaysmobilebanking", "Barclays"),
        Trusted("com.grppl.android.shell.CMBlloydsTSB73", "Lloyds"),
        Trusted("com.rbs.mobile.android.natwest", "NatWest"),
        Trusted("uk.co.hsbc.hsbcukmobilebanking", "HSBC"),
        Trusted("uk.co.santander.santanderUK", "Santander"),
        // Verified from the device's own Play Store listing (share-link id=…),
        // not guessed — see CapitalOneParser.kt. Package trust proves source
        // identity only; it never overrides DECLINED/UPCOMING/FAILED/PENDING/
        // REFUNDED semantic lifecycle classification (see classifier.ts).
        Trusted("com.ie.capitalone.uk", "Capital One"),
    )

    private val byPackage = all.associateBy { it.packageName }

    fun isTrusted(packageName: String): Boolean = byPackage.containsKey(packageName)

    fun displayName(packageName: String): String? = byPackage[packageName]?.displayName

    /**
     * Classify a source using the installed signing certificate (via [inspector])
     * and whether the user has approved it. Built-in packages are judged by their
     * configured pins; everything else by [userApproved].
     */
    fun resolveTrust(inspector: SignatureInspector, packageName: String, userApproved: Boolean): SourceTrust {
        val trusted = byPackage[packageName]
        val signers = inspector.sha256Signers(packageName)
        return classify(
            builtIn = trusted != null,
            pins = trusted?.signingSha256 ?: emptySet(),
            installedSigners = signers,
            userApproved = userApproved,
        )
    }

    /**
     * Pure trust decision. Kept free of Android APIs so it is exhaustively unit-testable.
     *
     * A built-in package is only [SourceTrustLevel.SIGNATURE_VERIFIED] when pins are
     * configured and one matches an installed signer. A configured-but-mismatched
     * signature is treated as [SourceTrustLevel.UNAPPROVED] (a spoof) — it is never
     * silently downgraded to [SourceTrustLevel.PACKAGE_ID_ONLY]. When no pins are
     * configured (or the signature could not be read) the level is
     * [SourceTrustLevel.PACKAGE_ID_ONLY]; it is never silently upgraded.
     */
    fun classify(
        builtIn: Boolean,
        pins: Set<String>,
        installedSigners: Set<String>?,
        userApproved: Boolean,
    ): SourceTrust {
        val checked = installedSigners != null
        val abbrev = abbreviate(installedSigners)
        if (builtIn) {
            if (pins.isEmpty()) {
                return SourceTrust(SourceTrustLevel.PACKAGE_ID_ONLY, builtIn = true, signatureChecked = checked, signatureMatched = null, signingSha256Abbrev = abbrev)
            }
            if (installedSigners == null) {
                // Pins exist but the certificate could not be read (transient / not installed).
                // Cannot verify → fall back to package-id trust; do not claim a match.
                return SourceTrust(SourceTrustLevel.PACKAGE_ID_ONLY, builtIn = true, signatureChecked = false, signatureMatched = null, signingSha256Abbrev = null)
            }
            val normalizedPins = pins.mapTo(HashSet()) { normalizeSha256(it) }
            val matched = installedSigners.any { normalizeSha256(it) in normalizedPins }
            return if (matched) {
                SourceTrust(SourceTrustLevel.SIGNATURE_VERIFIED, builtIn = true, signatureChecked = true, signatureMatched = true, signingSha256Abbrev = abbrev)
            } else {
                SourceTrust(SourceTrustLevel.UNAPPROVED, builtIn = true, signatureChecked = true, signatureMatched = false, signingSha256Abbrev = abbrev)
            }
        }
        val level = if (userApproved) SourceTrustLevel.USER_APPROVED else SourceTrustLevel.UNAPPROVED
        return SourceTrust(level, builtIn = false, signatureChecked = checked, signatureMatched = null, signingSha256Abbrev = abbrev)
    }

    /** Normalize a SHA-256 for comparison: drop colons/whitespace, upper-case. */
    fun normalizeSha256(raw: String): String = buildString(raw.length) {
        for (ch in raw) if (ch != ':' && !ch.isWhitespace()) append(ch.uppercaseChar())
    }

    /** Abbreviated, non-reversible representation of the first installed signer, for diagnostics. */
    private fun abbreviate(signers: Set<String>?): String? {
        val first = signers?.minOrNull() ?: return null
        val norm = normalizeSha256(first)
        if (norm.isEmpty()) return null
        return if (norm.length <= 20) norm else norm.take(8) + "…" + norm.takeLast(8)
    }
}

/**
 * Real [SignatureInspector] backed by the platform package manager, using the modern
 * signing-certificate APIs on API 28+ (including rotation history) and falling back to
 * the legacy signatures API on API 26–27. Returns null when the package is not installed
 * or the signing info cannot be read — never throws.
 */
class AndroidSignatureInspector(context: Context) : SignatureInspector {
    private val pm: PackageManager = context.applicationContext.packageManager

    override fun sha256Signers(packageName: String): Set<String>? = try {
        val signatures: Array<out Signature> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            val signingInfo = info.signingInfo ?: return null
            if (signingInfo.hasMultipleSigners()) {
                signingInfo.apkContentsSigners
            } else {
                // Single signer: include the full rotation lineage so a rotated key still verifies.
                signingInfo.signingCertificateHistory
            }
        } else {
            @Suppress("DEPRECATION")
            val info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES)
            @Suppress("DEPRECATION")
            info.signatures
        } ?: return null

        signatures.map { sha256Hex(it) }.toSet().takeIf { it.isNotEmpty() }
    } catch (_: PackageManager.NameNotFoundException) {
        null
    } catch (_: Exception) {
        null
    }

    private fun sha256Hex(sig: Signature): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(sig.toByteArray())
        return digest.joinToString("") { "%02X".format(it) }
    }
}
