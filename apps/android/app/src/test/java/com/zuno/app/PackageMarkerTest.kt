package com.zuno.app

import org.junit.Test
import org.junit.Assert.assertEquals

class PackageMarkerTest {
    @Test fun applicationPackageIsStable() {
        assertEquals("com.zuno.app", MainActivity::class.java.packageName)
    }
}
