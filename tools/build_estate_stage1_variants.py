import bpy
import math
import os
import sys
from mathutils import Vector


def args_after_double_dash():
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def make_material(name, base_color, metallic=0.0, roughness=0.6, emission=None, strength=0.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*base_color, 1.0)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    if emission:
        emission_input = shader.inputs.get("Emission Color") or shader.inputs.get("Emission")
        strength_input = shader.inputs.get("Emission Strength")
        if emission_input:
            emission_input.default_value = (*emission, 1.0)
        if strength_input:
            strength_input.default_value = strength
    return material


def add_box(name, location, dimensions, material, bevel=0.03):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if material:
        obj.data.materials.append(material)
    if bevel:
        modifier = obj.modifiers.new("Soft edges", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
    return obj


def add_cylinder(name, location, radius, depth, material, rotation=(0.0, 0.0, 0.0), vertices=12):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    if material:
        obj.data.materials.append(material)
    return obj


def add_torus(name, location, major_radius, minor_radius, material):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius,
        minor_radius=minor_radius,
        major_segments=20,
        minor_segments=8,
        location=location,
    )
    obj = bpy.context.object
    obj.name = name
    if material:
        obj.data.materials.append(material)
    return obj


def add_sphere(name, location, radius, material):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=radius, location=location)
    obj = bpy.context.object
    obj.name = name
    if material:
        obj.data.materials.append(material)
    return obj


def scene_bounds(objects):
    points = []
    for obj in objects:
        if obj.type != "MESH":
            continue
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    minimum = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    maximum = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return minimum, maximum


def export_glb(path, level):
    bpy.context.scene["token2_estate_stage"] = 1
    bpy.context.scene["token2_estate_level"] = level
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
        export_extras=True,
        export_cameras=False,
        export_lights=False,
    )


def render_preview(path):
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    minimum, maximum = scene_bounds(meshes)
    center = (minimum + maximum) * 0.5
    size = maximum - minimum
    radius = max(size.x, size.y, size.z)

    camera_data = bpy.data.cameras.new("Preview camera")
    camera = bpy.data.objects.new("Preview camera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera.location = center + Vector((radius * 1.55, -radius * 1.75, radius * 1.18))
    camera.rotation_euler = ((center - camera.location).to_track_quat("-Z", "Y")).to_euler()
    camera.data.lens = 54
    bpy.context.scene.camera = camera

    lights = []
    for name, location, energy, color, size_value in (
        ("Key", center + Vector((-radius, -radius, radius * 1.8)), 1100, (0.78, 0.92, 1.0), radius * 1.1),
        ("Warm fill", center + Vector((radius * 1.1, radius, radius)), 850, (1.0, 0.62, 0.32), radius),
        ("Rim", center + Vector((0, radius * 0.4, radius * 2.0)), 1250, (0.2, 0.75, 1.0), radius * 0.8),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.color = color
        data.shape = "DISK"
        data.size = size_value
        light = bpy.data.objects.new(name, data)
        light.location = location
        light.rotation_euler = ((center - light.location).to_track_quat("-Z", "Y")).to_euler()
        bpy.context.scene.collection.objects.link(light)
        lights.append(light)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = path
    scene.render.film_transparent = False
    if scene.world is None:
        scene.world = bpy.data.worlds.new("Preview world")
    scene.world.color = (0.004, 0.009, 0.018)
    bpy.ops.render.render(write_still=True)

    bpy.data.objects.remove(camera, do_unlink=True)
    for light in lights:
        bpy.data.objects.remove(light, do_unlink=True)


def main():
    args = args_after_double_dash()
    if len(args) != 2:
        raise SystemExit("usage: blender --background --python script.py -- input.glb output_dir")
    source_path, output_dir = map(os.path.abspath, args)
    os.makedirs(output_dir, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)
    imported = list(bpy.context.scene.objects)
    minimum, maximum = scene_bounds(imported)
    center = (minimum + maximum) * 0.5
    size = maximum - minimum

    # Tripo can return the house facing either horizontal axis. All upgrade pieces
    # stay symmetric so the three levels remain correct from every camera angle.
    metal = make_material("Upgrade dark alloy", (0.035, 0.075, 0.11), metallic=0.78, roughness=0.26)
    cyan = make_material("Upgrade cyan energy", (0.01, 0.22, 0.34), metallic=0.3, roughness=0.2, emission=(0.01, 0.58, 0.92), strength=2.8)
    glass = make_material("Upgrade power glass", (0.025, 0.12, 0.19), metallic=0.12, roughness=0.12, emission=(0.0, 0.34, 0.62), strength=1.8)

    # Lv.1 is the untouched Tripo source: the smallest, clearest starter house.
    export_glb(os.path.join(output_dir, "stage-1-lv1.glb"), 1)
    render_preview(os.path.join(output_dir, "stage-1-lv1-preview.png"))

    inset_x = max(size.x * 0.08, 0.04)
    inset_y = max(size.y * 0.08, 0.04)
    post_height = size.z * 0.72
    post_z = minimum.z + post_height * 0.5
    post_width = max(min(size.x, size.y) * 0.035, 0.025)
    for x in (minimum.x + inset_x, maximum.x - inset_x):
        for y in (minimum.y + inset_y, maximum.y - inset_y):
            add_box("Lv2 corner reinforcement", (x, y, post_z), (post_width, post_width, post_height), metal, post_width * 0.3)

    module_w = max(size.x * 0.24, 0.16)
    module_d = max(size.y * 0.10, 0.09)
    module_h = max(size.z * 0.24, 0.18)
    add_box(
        "Lv2 east power module",
        (maximum.x + module_d * 0.28, center.y, minimum.z + module_h * 0.62),
        (module_d, module_w, module_h),
        metal,
        module_d * 0.18,
    )
    for offset in (-0.27, 0.27):
        add_box(
            "Lv2 cyan energy strip",
            (maximum.x + module_d * 0.56, center.y + module_w * offset, minimum.z + module_h * 0.65),
            (module_d * 0.08, module_w * 0.32, module_h * 0.55),
            cyan,
            0.01,
        )
    lamp_z = minimum.z + size.z * 0.55
    for y in (minimum.y - module_d * 0.18, maximum.y + module_d * 0.18):
        add_box("Lv2 portal lamp", (center.x, y, lamp_z), (size.x * 0.13, module_d * 0.12, size.z * 0.035), cyan, 0.01)
    export_glb(os.path.join(output_dir, "stage-1-lv2.glb"), 2)
    render_preview(os.path.join(output_dir, "stage-1-lv2-preview.png"))

    # Lv.3 keeps every Lv.2 part and adds a roof energy spine, twin side cells,
    # and a raised power core. The silhouette changes without replacing the house.
    ridge_z = maximum.z + max(size.z * 0.045, 0.05)
    ridge_len = max(size.x, size.y) * 0.68
    along_x = size.x >= size.y
    ridge_dimensions = (ridge_len, post_width * 1.5, post_width * 1.5) if along_x else (post_width * 1.5, ridge_len, post_width * 1.5)
    add_box("Lv3 roof energy spine", (center.x, center.y, ridge_z), ridge_dimensions, metal, post_width * 0.45)
    core_z = ridge_z + size.z * 0.09
    core_radius = max(post_width * 1.35, 0.055)
    add_cylinder("Lv3 roof power core", (center.x, center.y, core_z), core_radius, size.z * 0.17, glass, vertices=16)
    add_torus("Lv3 power halo", (center.x, center.y, core_z), core_radius * 1.55, core_radius * 0.18, cyan)
    add_sphere("Lv3 core crystal", (center.x, center.y, core_z + size.z * 0.125), core_radius * 0.72, cyan)

    for side in (-1, 1):
        x = minimum.x - module_d * 0.32 if side < 0 else maximum.x + module_d * 0.32
        add_box("Lv3 side energy cell", (x, center.y, minimum.z + module_h * 0.55), (module_d, module_w * 0.82, module_h * 0.92), metal, module_d * 0.18)
        add_box("Lv3 side cell glow", (x + side * module_d * 0.52, center.y, minimum.z + module_h * 0.58), (module_d * 0.06, module_w * 0.5, module_h * 0.58), cyan, 0.01)

    band_z = minimum.z + size.z * 0.74
    for y in (minimum.y - post_width * 0.45, maximum.y + post_width * 0.45):
        add_box("Lv3 facade energy band", (center.x, y, band_z), (size.x * 0.72, post_width * 0.22, post_width * 0.65), cyan, 0.01)
    export_glb(os.path.join(output_dir, "stage-1-lv3.glb"), 3)
    render_preview(os.path.join(output_dir, "stage-1-lv3-preview.png"))

    print(f"STAGE1_VARIANTS_OK bounds={tuple(round(v, 4) for v in size)} output={output_dir}")


if __name__ == "__main__":
    main()
