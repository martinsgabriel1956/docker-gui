"""Servidor de notificações falso (org.freedesktop.Notifications) para o desktop-smoke.sh: anota cada Notify, com a
hora, no arquivo do primeiro argumento. Só a stdlib e o gi (Gio), que o GNOME já traz."""
import sys
import time

from gi.repository import Gio, GLib

XML = """<node><interface name="org.freedesktop.Notifications">
<method name="Notify"><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/>
<arg type="i" direction="in"/><arg type="u" direction="out"/></method>
<method name="GetCapabilities"><arg type="as" direction="out"/></method>
<method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/>
<arg type="s" direction="out"/><arg type="s" direction="out"/></method>
<method name="CloseNotification"><arg type="u" direction="in"/></method>
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
</interface></node>"""
LOG, count = sys.argv[1], [0]


def call(_conn, _sender, _path, _iface, method, params, inv):
    if method == "Notify":
        count[0] += 1
        with open(LOG, "a") as f:
            f.write(f"{time.time():.3f}\t{params[3]}\n")
        inv.return_value(GLib.Variant("(u)", (count[0],)))
    elif method == "GetCapabilities":
        inv.return_value(GLib.Variant("(as)", (["body", "actions"],)))
    elif method == "GetServerInformation":
        inv.return_value(GLib.Variant("(ssss)", ("fake", "stivo", "1", "1.2")))
    else:
        inv.return_value(None)


def acquired(conn, _name):
    conn.register_object("/org/freedesktop/Notifications", Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], call)


Gio.bus_own_name(Gio.BusType.SESSION, "org.freedesktop.Notifications", 0, acquired, None, None)
GLib.MainLoop().run()
