package com.zuno.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Ink = Color(0xFF0D0D15)
private val Panel = Color(0xFF191927)
private val Violet = Color(0xFF9A7CFF)
private val Muted = Color(0xFFAAA6C3)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { ZunoApp() }
    }
}

@Composable
private fun ZunoApp() {
    var selected by remember { mutableStateOf("Home") }
    MaterialTheme(colorScheme = darkColorScheme(
        primary = Violet, background = Ink, surface = Panel,
        onBackground = Color.White, onSurface = Color.White
    )) {
        Scaffold(
            containerColor = Ink,
            bottomBar = {
                NavigationBar(containerColor = Panel) {
                    listOf("Home", "Discover", "LIVE", "Inbox", "Profile").forEach { item ->
                        NavigationBarItem(
                            selected = selected == item,
                            onClick = { selected = item },
                            icon = { Text(when(item) { "Home" -> "⌂"; "Discover" -> "⌕"; "LIVE" -> "◉"; "Inbox" -> "▤"; else -> "○" }) },
                            label = { Text(item, fontSize = 10.sp) }
                        )
                    }
                }
            }
        ) { padding ->
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 18.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                item {
                    Row(Modifier.fillMaxWidth().padding(top = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                        Surface(color = Violet, shape = MaterialTheme.shapes.medium) {
                            Text("Z", Modifier.padding(horizontal = 12.dp, vertical = 7.dp), fontSize = 20.sp, fontWeight = FontWeight.Black)
                        }
                        Spacer(Modifier.width(10.dp))
                        Text("ZUNO", fontSize = 24.sp, fontWeight = FontWeight.Black)
                        Spacer(Modifier.weight(1f))
                        Text("PREVIEW", color = Muted, fontSize = 10.sp)
                    }
                }
                item {
                    Column(Modifier.fillMaxWidth().background(Panel, MaterialTheme.shapes.extraLarge).padding(22.dp)) {
                        Text("ONE PLATFORM. MANY WORLDS.", color = Violet, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(9.dp))
                        Text(if (selected == "Home") "Your world, all in one place." else selected, fontSize = 31.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(8.dp))
                        Text("Discover stories, find your people, explore LIVE and create something unforgettable.", color = Muted, fontSize = 13.sp)
                        Spacer(Modifier.height(17.dp))
                        Button(onClick = { selected = "Discover" }, colors = ButtonDefaults.buttonColors(containerColor = Violet)) {
                            Text("Explore ZUNO")
                        }
                    }
                }
                item { Text("EXPLORE YOUR INTERESTS", color = Violet, fontSize = 10.sp, fontWeight = FontWeight.Bold) }
                item { FeatureCard("Video & stories", "Short video, long-form, photos and creator stories", "▶") { selected = "Discover" } }
                item { FeatureCard("LIVE & entertainment", "Music, gaming and audience conversations", "◉") { selected = "LIVE" } }
                item { FeatureCard("Communities", "Bring groups, channels and events together", "◎") { selected = "Discover" } }
                item { FeatureCard("Creator tools", "Prepare content and build your creative presence", "✦") { selected = "Profile" } }
                item {
                    Column(Modifier.fillMaxWidth().background(Panel, MaterialTheme.shapes.large).padding(17.dp)) {
                        Text("Connection status", fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(5.dp))
                        Text("This native UI does not claim provider connectivity. Authentication, feed data and LIVE room state are connected in later integration work.", color = Muted, fontSize = 11.sp)
                    }
                }
                item { Spacer(Modifier.height(12.dp)) }
            }
        }
    }
}

@Composable
private fun FeatureCard(title: String, detail: String, icon: String, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = Panel),
        shape = MaterialTheme.shapes.large
    ) {
        Row(Modifier.padding(17.dp), verticalAlignment = Alignment.CenterVertically) {
            Surface(color = Color(0xFF2A2543), shape = MaterialTheme.shapes.medium) {
                Text(icon, Modifier.padding(13.dp), color = Violet, fontSize = 21.sp)
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Spacer(Modifier.height(4.dp))
                Text(detail, color = Muted, fontSize = 11.sp)
            }
            Text("↗", color = Violet, fontSize = 18.sp)
        }
    }
}
