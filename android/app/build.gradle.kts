plugins {
	id("com.android.application")
}

val lhVersion: String = (project.findProperty("lhVersion") as String?) ?: "0.0.0-dev"

android {
	namespace = "com.learnharness.android"
	compileSdk = 36

	defaultConfig {
		applicationId = "com.learnharness.android"
		minSdk = 29
		targetSdk = 36
		versionCode = 1
		versionName = lhVersion
		ndk { abiFilters += "arm64-v8a" }
	}

	signingConfigs {
		// Sideload build: signed with the local debug key (kept under .sdks).
		getByName("debug")
	}
	buildTypes {
		release {
			isMinifyEnabled = false
			signingConfig = signingConfigs.getByName("debug")
		}
	}

	packaging {
		// Native libs must be EXTRACTED at install: the server process is
		// exec'd from the native library directory (libnode.so).
		jniLibs.useLegacyPackaging = true
	}
	androidResources {
		// server.zip is already compressed.
		noCompress += "zip"
	}
	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}
}
