# Kotlinx serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class **$$serializer { *; }
-keepclasseswithmembers class uk.co.prisom.directbanking.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class uk.co.prisom.directbanking.data.remote.dto.** { *; }

# Retrofit
-keepattributes Signature, Exceptions
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**

# Room (generated)
-keep class * extends androidx.room.RoomDatabase { <init>(); }

# Keep the notification listener service name (bound by the system).
-keep class uk.co.prisom.directbanking.notifications.BankNotificationListenerService { *; }

# Tink (via androidx.security.crypto / EncryptedSharedPreferences) references
# compile-only annotations that are not on the runtime classpath.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
