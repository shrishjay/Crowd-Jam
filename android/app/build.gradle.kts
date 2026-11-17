plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "pe.nxt.crowdsynth"
    compileSdk = 34
    defaultConfig { applicationId = "pe.nxt.crowdsynth"; minSdk = 24; targetSdk = 34; versionCode = 1; versionName = "0.1.0" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
