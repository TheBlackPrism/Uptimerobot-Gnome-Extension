UUID = uptimerobot@theblackprism.ch
ZIP = $(UUID).shell-extension.zip

.PHONY: all pack install uninstall clean

all: pack

pack:
	gnome-extensions pack --force \
		--schema=schemas/org.gnome.shell.extensions.uptimerobot.gschema.xml \
		.

install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Log out and back in (or restart GNOME Shell on X11), then run:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -f $(ZIP) schemas/gschemas.compiled
