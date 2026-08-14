import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// Release signing (Phase 5 hardening). Credentials come from either environment
// variables (CI) or an untracked keystore.properties (local) — a keystore is NEVER
// committed and passwords are NEVER printed. When no credentials are present, debug
// builds still work and release artifacts build unsigned (for Play App Signing or
// manual signing later). When credentials ARE present, assembleRelease produces a
// properly signed APK.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

// Environment overrides take precedence over keystore.properties.
fun signingValue(envName: String, propName: String): String? =
    (System.getenv(envName) ?: keystoreProps.getProperty(propName))?.takeIf { it.isNotBlank() }

val ksStoreFile = signingValue("DIRECT_BANKING_KEYSTORE_PATH", "storeFile")
val ksStorePassword = signingValue("DIRECT_BANKING_KEYSTORE_PASSWORD", "storePassword")
val ksKeyAlias = signingValue("DIRECT_BANKING_KEY_ALIAS", "keyAlias")
val ksKeyPassword = signingValue("DIRECT_BANKING_KEY_PASSWORD", "keyPassword")
val releaseSigningReady = ksStoreFile != null && ksStorePassword != null && ksKeyAlias != null && ksKeyPassword != null

android {
    namespace = "uk.co.prisom.directbanking"
    compileSdk = 36

    defaultConfig {
        applicationId = "uk.co.prisom.directbanking"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Base URL of the deployed Direct Banking API. No secrets are embedded.
        buildConfigField("String", "API_BASE_URL", "\"https://direct-banking.doorstepmanchester.uk/\"")
    }

    signingConfigs {
        if (releaseSigningReady) {
            create("release") {
                storeFile = file(ksStoreFile!!)
                storePassword = ksStorePassword
                keyAlias = ksKeyAlias
                keyPassword = ksKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isDebuggable = true
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signed only when credentials are supplied; otherwise unsigned (still builds).
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests {
            isReturnDefaultValues = true
            isIncludeAndroidResources = true
        }
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "/META-INF/LICENSE*"
        }
    }
    lint {
        warningsAsErrors = false
        abortOnError = true
        // PropertyEscape flags the machine-specific, gitignored local.properties
        // (unescaped Windows SDK path) — not app code.
        disable += setOf("GradleDependency", "NewerVersionAvailable", "PropertyEscape")
    }
}

// Export Room schemas so migrations can be validated and tracked in version control.
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

// Kotlin 2.3 compiler options (replaces the removed kotlinOptions DSL).
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.splashscreen)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.navigation.compose)
    debugImplementation(libs.androidx.ui.tooling)

    implementation(libs.retrofit)
    implementation(libs.retrofit.kotlinx.serialization)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.datastore.preferences)

    // Plaid Link — launches the bank authorization journey for Plaid-backed connections.
    implementation(libs.plaid.link)

    testImplementation(libs.junit)
    testImplementation(libs.mockk)
    testImplementation(libs.turbine)
    testImplementation(libs.robolectric)
    testImplementation(libs.kotlinx.coroutines.test)
}
