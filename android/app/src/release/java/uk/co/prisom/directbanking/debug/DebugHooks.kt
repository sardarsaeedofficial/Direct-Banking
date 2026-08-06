package uk.co.prisom.directbanking.debug

import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder

/** Release variant: debug tools are absent from release builds. */
object DebugHooks {
    val simulatorRoute: String? = null
}

fun NavGraphBuilder.addDebugDestinations(navController: NavController) {
    // No debug destinations in release builds.
}
