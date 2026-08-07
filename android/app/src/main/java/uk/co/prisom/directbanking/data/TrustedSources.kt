package uk.co.prisom.directbanking.data

import android.content.Context
import android.content.pm.PackageManager

/**
 * Built-in trusted UK banking apps, keyed by their **exact** official Android
 * package id (a visible label of "Barclays" etc. is never enough on its own).
 *
 * Optional [signingSha256] certificate pins can be supplied to additionally
 * verify the installed app was signed by the bank. They are intentionally left
 * empty here because shipping unverified certificate hashes would be worse than
 * none; populate them from each bank's published signing certificate to enable
 * signature checking (see [verifySignature]).
 */
object TrustedSources {

    data class Trusted(val packageName: String, val displayName: String, val signingSha256: Set<String> = emptySet())

    val all: List<Trusted> = listOf(
        Trusted("co.uk.getmondo", "Monzo"),
        Trusted("com.revolut.revolut", "Revolut"),
        Trusted("com.starlingbank.android", "Starling"),
        Trusted("com.barclays.android.barclaysmobilebanking", "Barclays"),
        Trusted("com.grppl.android.shell.CMBlloydsTSB73", "Lloyds"),
        Trusted("com.rbs.mobile.android.natwest", "NatWest"),
        Trusted("uk.co.hsbc.hsbcukmobilebanking", "HSBC"),
        Trusted("uk.co.santander.santanderUK", "Santander"),
    )

    private val byPackage = all.associateBy { it.packageName }

    fun isTrusted(packageName: String): Boolean = byPackage.containsKey(packageName)

    fun displayName(packageName: String): String? = byPackage[packageName]?.displayName

    /**
     * When certificate pins are configured for [packageName], verify the installed
     * app was signed by one of them. Returns true if trusted with no pins (package
     * id only) or if a pin matches; false if pins are configured but none match.
     */
    fun verifySignature(context: Context, packageName: String): Boolean {
        val trusted = byPackage[packageName] ?: return false
        if (trusted.signingSha256.isEmpty()) return true // package-id trust only
        val hashes = installedSigningSha256(context, packageName)
        return hashes.any { it in trusted.signingSha256 }
    }

    private fun installedSigningSha256(context: Context, packageName: String): Set<String> = try {
        val pm = context.packageManager
        @Suppress("DEPRECATION")
        val flags = PackageManager.GET_SIGNATURES
        @Suppress("DEPRECATION")
        val sigs = pm.getPackageInfo(packageName, flags).signatures ?: emptyArray()
        sigs.map { sig ->
            val md = java.security.MessageDigest.getInstance("SHA-256").digest(sig.toByteArray())
            md.joinToString(":") { "%02X".format(it) }
        }.toSet()
    } catch (_: Exception) {
        emptySet()
    }
}
