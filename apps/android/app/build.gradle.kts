plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
android {
    namespace = "com.zuno.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.zuno.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures { compose = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}
val repoRoot = rootProject.projectDir.parentFile.parentFile

val buildZunoWeb = tasks.register<Exec>("buildZunoWeb") {
    group = "zuno"
    description = "Build the production ZUNO web/PWA bundle before packaging Android assets."
    workingDir(repoRoot)
    commandLine("pnpm", "build:web")
}

val syncZunoWebAssets = tasks.register<Sync>("syncZunoWebAssets") {
    group = "zuno"
    description = "Bundle the complete web app and its model/media assets inside the APK."
    dependsOn(buildZunoWeb)
    from(file("${repoRoot}/dist/web"))
    into(layout.projectDirectory.dir("src/main/assets/zuno-web"))
}
tasks.named("preBuild").configure { dependsOn(syncZunoWebAssets) }

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.webkit:webkit:1.18.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
}
