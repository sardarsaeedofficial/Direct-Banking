package uk.co.prisom.directbanking.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Trust classification is pure (no Android framework), so signature verification is
 * exhaustively unit-tested here with an injected [SignatureInspector] fake.
 */
class TrustedSourcesTest {

    private val monzo = "co.uk.getmondo"
    // Two distinct, well-formed SHA-256 hex fingerprints (formatting varies on purpose).
    private val realCert = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
    private val realCertNoColons = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
    private val attackerCert = "11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF"
    private val rotatedOldCert = "99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA"

    private fun inspector(vararg entries: Pair<String, Set<String>?>): SignatureInspector {
        val map = entries.toMap()
        return object : SignatureInspector {
            override fun sha256Signers(packageName: String): Set<String>? = map[packageName]
        }
    }

    @Test fun `known package with a matching configured certificate is SIGNATURE_VERIFIED`() {
        val trust = TrustedSources.classify(builtIn = true, pins = setOf(realCert), installedSigners = setOf(realCert), userApproved = false)
        assertEquals(SourceTrustLevel.SIGNATURE_VERIFIED, trust.level)
        assertTrue(trust.builtIn)
        assertTrue(trust.signatureChecked)
        assertEquals(true, trust.signatureMatched)
    }

    @Test fun `known package with a wrong certificate does NOT become SIGNATURE_VERIFIED`() {
        val trust = TrustedSources.classify(builtIn = true, pins = setOf(realCert), installedSigners = setOf(attackerCert), userApproved = false)
        assertNotEquals(SourceTrustLevel.SIGNATURE_VERIFIED, trust.level)
        assertEquals(SourceTrustLevel.UNAPPROVED, trust.level)
        assertEquals(false, trust.signatureMatched)
    }

    @Test fun `known package with no configured pins is PACKAGE_ID_ONLY`() {
        val trust = TrustedSources.classify(builtIn = true, pins = emptySet(), installedSigners = setOf(realCert), userApproved = false)
        assertEquals(SourceTrustLevel.PACKAGE_ID_ONLY, trust.level)
        assertTrue(trust.signatureChecked) // we read the installed signature…
        assertEquals(null, trust.signatureMatched) // …but there was nothing configured to match
    }

    @Test fun `unknown package is initially UNAPPROVED`() {
        val trust = TrustedSources.resolveTrust(inspector("com.example.unknown" to setOf(attackerCert)), "com.example.unknown", userApproved = false)
        assertEquals(SourceTrustLevel.UNAPPROVED, trust.level)
        assertTrue(!trust.builtIn)
    }

    @Test fun `user approval of a non-built-in source is USER_APPROVED`() {
        val trust = TrustedSources.resolveTrust(inspector("com.example.unknown" to setOf(attackerCert)), "com.example.unknown", userApproved = true)
        assertEquals(SourceTrustLevel.USER_APPROVED, trust.level)
    }

    @Test fun `certificate formatting differences normalize correctly`() {
        // Configured pin has colons + upper-case; installed signer is lower-case, no colons.
        val trust = TrustedSources.classify(builtIn = true, pins = setOf(realCert), installedSigners = setOf(realCertNoColons), userApproved = false)
        assertEquals(SourceTrustLevel.SIGNATURE_VERIFIED, trust.level)
    }

    @Test fun `legitimate signing-key history is accepted`() {
        // Pin is the current key; the installed app reports its rotation lineage (old + current).
        val trust = TrustedSources.classify(builtIn = true, pins = setOf(realCert), installedSigners = setOf(rotatedOldCert, realCert), userApproved = false)
        assertEquals(SourceTrustLevel.SIGNATURE_VERIFIED, trust.level)
    }

    @Test fun `a wrong signature cannot gain verified trust by reusing a bank package name`() {
        // Attacker ships an app claiming Monzo's package id but signed by a different key.
        // Even with the genuine Monzo pin configured, the mismatch must block verified trust.
        assertEquals(monzo, TrustedSources.all.first().packageName) // guard: monzo is a built-in id
        val trust = TrustedSources.classify(
            builtIn = true,
            pins = setOf(realCert),
            installedSigners = setOf(attackerCert),
            userApproved = false,
        )
        assertNotEquals(SourceTrustLevel.SIGNATURE_VERIFIED, trust.level)
        assertEquals(SourceTrustLevel.UNAPPROVED, trust.level)
    }

    @Test fun `configured pins but an unreadable signature falls back to PACKAGE_ID_ONLY not verified`() {
        // Signature could not be read (e.g. transient PM failure): never claim a match.
        val trust = TrustedSources.classify(builtIn = true, pins = setOf(realCert), installedSigners = null, userApproved = false)
        assertEquals(SourceTrustLevel.PACKAGE_ID_ONLY, trust.level)
        assertEquals(null, trust.signatureMatched)
    }

    @Test fun `every built-in bank currently classifies as PACKAGE_ID_ONLY (no pins shipped)`() {
        val insp = inspector(*TrustedSources.all.map { it.packageName to setOf(realCert) as Set<String>? }.toTypedArray())
        for (bank in TrustedSources.all) {
            val trust = TrustedSources.resolveTrust(insp, bank.packageName, userApproved = false)
            assertEquals("${bank.displayName} should be package-id only until a pin is added", SourceTrustLevel.PACKAGE_ID_ONLY, trust.level)
        }
    }
}
