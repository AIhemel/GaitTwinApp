package com.gaittwinapp

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

/**
 * Required by Health Connect: an activity that explains why this app reads health data, shown
 * when the user taps "About this app" from Health Connect's permission/data-access screens.
 * Responds to androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE (Android <=13) and is also
 * targeted by the ViewPermissionUsageActivity alias for android.intent.action.VIEW_PERMISSION_USAGE
 * (Android 14+) — see AndroidManifest.xml.
 */
class PermissionsRationaleActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val text = TextView(this).apply {
      setPadding(48, 96, 48, 48)
      textSize = 16f
      text = "GaitTwin Digital Health Twin\n\n" +
        "This app reads fitness and vitals data (such as steps, heart rate, sleep, and calories) " +
        "from Health Connect, sourced from your connected fitness band via its companion app. " +
        "This data is used only to visualize your activity and to log it, with timestamps, to a " +
        "CSV file on your device for this thesis project's analysis. It is not uploaded or shared " +
        "with any third party."
    }

    setContentView(ScrollView(this).apply { addView(text) })
  }
}
