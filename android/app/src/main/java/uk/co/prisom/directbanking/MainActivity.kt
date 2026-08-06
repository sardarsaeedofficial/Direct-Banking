package uk.co.prisom.directbanking

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import uk.co.prisom.directbanking.ui.LocalContainer
import uk.co.prisom.directbanking.ui.navigation.AppRoot
import uk.co.prisom.directbanking.ui.theme.DirectBankingTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as DirectBankingApp).container
        setContent {
            DirectBankingTheme {
                CompositionLocalProvider(LocalContainer provides container) {
                    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        AppRoot()
                    }
                }
            }
        }
    }
}
